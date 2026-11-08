import { Plugin } from "@opencode/plugin"
import { Delayed } from "./rpc"

// /delayed <time> <message>
//
// The command is registered by the plugin, so the message never becomes a user
// prompt at scheduling time: it stays inside `execute` and the model sees it
// only when the timer delivers it as a real user prompt.

type Origin = "user" | "agent"

type Job = {
  id: string
  sessionID: string
  message: string
  fireAt: number
  directory: string
  origin: Origin
}

const MAX_TIMER = 2 ** 31 - 1
const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }

// Jobs stored before the origin field existed belong to the user.
const originOf = (job: { origin?: string }): Origin => (job.origin === "agent" ? "agent" : "user")

// Setup can run more than once per directory; only the first timer may deliver.
const claimed = new Set<string>()
// Guards concurrent deliveries of one job while the prompt is in flight.
const delivering = new Set<string>()

type Delivery = "delivered" | "busy" | "failed"

const key = (id: string) => `pending/${id}`

const resolveTime = (raw: string, now: number): number | string => {
  const relative = /^\+?(\d+)([smhd])$/.exec(raw)
  if (relative) return now + Number(relative[1]) * UNIT_MS[relative[2]]

  const clock = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(raw)
  if (clock) {
    const hours = Number(clock[1])
    const minutes = Number(clock[2])
    const seconds = Number(clock[3] ?? 0)
    if (hours > 23 || minutes > 59 || seconds > 59) return `invalid clock time: ${raw}`
    const at = new Date(now)
    at.setHours(hours, minutes, seconds, 0)
    if (at.getTime() <= now) at.setDate(at.getDate() + 1)
    return at.getTime()
  }

  const at = Date.parse(raw)
  if (Number.isNaN(at)) return `cannot parse time: ${raw}`
  if (at <= now) return `time is in the past: ${raw}`
  return at
}

const previewOf = (message: string) => message.replace(/\s+/g, " ").trim().slice(0, 120)

const pad = (value: number) => String(value).padStart(2, "0")

const stamp = (at: number) => {
  const date = new Date(at)
  const seconds = date.getSeconds()
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}${seconds === 0 ? "" : `:${pad(seconds)}`}`
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${time}`
}

const until = (at: number) => {
  const ms = at - Date.now()
  if (ms <= 0) return "now"
  if (ms < 60_000) return `${Math.ceil(ms / 1000)}s`
  const minutes = Math.ceil(ms / 60_000)
  const hours = Math.floor(minutes / 60)
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`
  if (hours > 0) return `${hours}h ${minutes % 60}m`
  return `${minutes}m`
}

// Older versions wrote notices into the transcript. Drop them from every model
// request: the sentinel covers 0.1.11, and the legacy text patterns cover the
// pre-fix notes that carried their text without a marker.
const NOTICE = "\u200b[delayed-message]"
const LEGACY_NOTICE =
  /^(?:Usage: \/delayed <time> <message>\nTime: |Delayed message (?:not scheduled: |failed: |scheduled for \d{4}-\d{2}-\d{2} ))/
const isNotice = (message: { role: string; content: ReadonlyArray<{ type: string; text?: string | null }> }) =>
  message.role === "user" &&
  message.content.some(
    (part) =>
      part.type === "text" &&
      (part.text?.startsWith(NOTICE) === true || (part.text !== undefined && part.text !== null && LEGACY_NOTICE.test(part.text))),
  )

const dropNotices = (
  event: { messages: Array<{ role: string; content: ReadonlyArray<{ type: string; text?: string | null }> }> },
) => {
  for (let index = event.messages.length - 1; index >= 0; index--) {
    const message = event.messages[index]
    if (message && isNotice(message)) event.messages.splice(index, 1)
  }
}

export default Plugin.define({
  id: "delayed-message",
  async setup(ctx) {
    const timers = new Map<string, ReturnType<typeof setTimeout>>()

    const listJobs = async (sessionID: string): Promise<Job[]> => {
      const jobs: Job[] = []
      let after: string | undefined
      do {
        const page = await ctx.storage.scan(after ? { prefix: "pending/", after } : { prefix: "pending/" })
        for (const entry of page.entries) {
          const job = entry.value as Job | undefined
          if (!job?.id || !job.sessionID || !job.message || !job.fireAt) continue
          if (job.sessionID !== sessionID) continue
          jobs.push({ ...job, origin: originOf(job) })
        }
        after = page.next
      } while (after)
      return jobs
    }

    const rpc = await ctx.rpc.register(Delayed, {
      pending: async (input) => {
        const { sessionID } = input as { sessionID: string }
        const jobs = (await listJobs(sessionID)).map((job) => ({
          id: job.id,
          fireAt: job.fireAt,
          preview: previewOf(job.message),
          text: job.message,
          origin: job.origin,
        }))
        return { jobs }
      },
      cancel: async (input) => {
        const { sessionID, id } = input as { sessionID: string; id: string }
        return { ok: (await withdraw(sessionID, id)) !== undefined }
      },
      edit: async (input) => {
        const { sessionID, id } = input as { sessionID: string; id: string }
        const job = await withdraw(sessionID, id)
        if (!job) return { ok: false }
        return { ok: true, text: job.message, fireAt: job.fireAt }
      },
      update: async (input) => {
        const { sessionID, id, text, time } = input as {
          sessionID: string
          id: string
          text?: string
          time?: string
        }
        const stored = (await ctx.storage.get(key(id))) as Job | undefined
        if (!stored || stored.sessionID !== sessionID) return { ok: false, error: "not found" }
        if (claimed.has(id) || delivering.has(id)) return { ok: false, error: "already delivering" }
        if (text !== undefined && !text.trim()) return { ok: false, error: "message is empty" }
        const fireAt = time === undefined ? stored.fireAt : resolveTime(time, Date.now())
        if (typeof fireAt === "string") return { ok: false, error: fireAt }
        const timer = timers.get(id)
        if (timer) {
          clearTimeout(timer)
          timers.delete(id)
        }
        const job: Job = { ...stored, message: text ?? stored.message, fireAt, origin: originOf(stored) }
        try {
          await ctx.storage.set(key(id), job)
        } catch (error) {
          arm(stored)
          throw error
        }
        arm(job)
        await rpc.events.emit("scheduled", {
          sessionID,
          id,
          fireAt,
          preview: previewOf(job.message),
          text: job.message,
          directory: job.directory,
          origin: job.origin,
        }).catch(() => {})
        return { ok: true, fireAt }
      },
      deliver: async (input) => {
        const { sessionID, id } = input as { sessionID: string; id: string }
        if (claimed.has(id)) return { status: "delivered" }
        if (delivering.has(id)) return { status: "busy" }
        const stored = (await ctx.storage.get(key(id))) as Job | undefined
        if (!stored || stored.sessionID !== sessionID) return { status: "missing" }
        return { status: await deliver(stored) }
      },
    })

    // Drop old transcript notices from every request that carries history.
    await ctx.session.hook("context", dropNotices)
    await ctx.session.hook("compaction", dropNotices)
    await ctx.session.hook("generate", dropNotices)
    await ctx.session.hook("title", dropNotices)

    const withdraw = async (sessionID: string, id: string): Promise<Job | undefined> => {
      if (claimed.has(id) || delivering.has(id)) return undefined
      const stored = (await ctx.storage.get(key(id))) as Job | undefined
      if (!stored || stored.sessionID !== sessionID) return undefined
      claimed.add(id)
      const timer = timers.get(id)
      if (timer) {
        clearTimeout(timer)
        timers.delete(id)
      }
      await ctx.storage.remove(key(id))
      await rpc.events.emit("cancelled", { sessionID, id }).catch(() => {})
      return stored
    }

    const deliver = async (job: Job): Promise<Delivery> => {
      if (claimed.has(job.id)) return "delivered"
      if (delivering.has(job.id)) return "busy"
      delivering.add(job.id)
      try {
        if (originOf(job) === "agent")
          await ctx.session.synthetic({
            sessionID: job.sessionID,
            text: job.message,
            description: `Scheduled by agent — ${previewOf(job.message)}`,
            metadata: { "delayed-message": { id: job.id, origin: "agent" } },
            delivery: "queue",
          })
        else await ctx.session.prompt({ sessionID: job.sessionID, text: job.message })
      } catch (error) {
        console.error(`[delayed-message] delivery failed for ${job.id}:`, error)
        return "failed"
      } finally {
        delivering.delete(job.id)
      }
      // Claim only after the prompt landed: a failure keeps the job in storage
      // for the next boot or for the desktop main process to retry.
      claimed.add(job.id)
      timers.delete(job.id)
      await ctx.storage.remove(key(job.id)).catch(() => {})
      await rpc.events.emit("fired", { sessionID: job.sessionID, id: job.id }).catch(() => {})
      return "delivered"
    }

    // setTimeout caps at MAX_TIMER, so long waits are split into hops.
    const arm = (job: Job) => {
      const delay = job.fireAt - Date.now()
      if (delay <= 0) {
        void deliver(job)
        return
      }
      const timer = setTimeout(() => {
        timers.delete(job.id)
        arm(job)
      }, Math.min(delay, MAX_TIMER - 1))
      timers.set(job.id, timer)
    }

    // The model sees only its own delayed messages. User-scheduled messages and
    // their ids never reach this tool.
    await ctx.tool.transform((editor) => {
      editor.add({
        name: "delayed",
        description: [
          "Schedule a message that this session delivers to itself later.",
          "Use it to check back on long-running work, wait for a deploy, or resume a task after a pause.",
          "When the time comes the message wakes this session as a synthetic note, not as a message from the user, and the user sees that the agent scheduled it.",
          "Write text so it makes sense on its own: by the time it arrives the conversation may have been compacted.",
          "Actions: schedule (time + text), list (only messages you scheduled in this session), cancel (id).",
          "Messages scheduled by the user are not visible to you.",
        ].join(" "),
        input: {
          type: "object",
          properties: {
            action: {
              type: "string",
              enum: ["schedule", "list", "cancel"],
              description: "schedule creates a message; list shows yours; cancel removes one by id.",
            },
            time: {
              type: "string",
              description:
                "When to deliver: 10m, 2h, 1d, HH:MM, or YYYY-MM-DDTHH:MM (local time). Required for schedule.",
            },
            text: {
              type: "string",
              description:
                "The message to deliver later. Required for schedule. Make it self-contained: the conversation may have been compacted by then.",
            },
            id: {
              type: "string",
              description: "Id returned by schedule. Required for cancel.",
            },
          },
          required: ["action"],
          additionalProperties: false,
        } as const,
        execute: async (input, context) => {
          const { action, time, text, id } = input as {
            action?: string
            time?: string
            text?: string
            id?: string
          }

          if (action === "schedule") {
            const message = text?.trim()
            if (!message) return { content: "Error: text is required for schedule." }
            if (!time) return { content: "Error: time is required for schedule." }
            const at = resolveTime(time, Date.now())
            if (typeof at === "string") return { content: `Error: ${at}.` }

            const job: Job = {
              id: crypto.randomUUID(),
              sessionID: context.sessionID,
              message,
              fireAt: at,
              directory: ctx.location.directory,
              origin: "agent",
            }
            await ctx.storage.set(key(job.id), job)
            arm(job)
            await rpc.events.emit("scheduled", {
              sessionID: job.sessionID,
              id: job.id,
              fireAt: job.fireAt,
              preview: previewOf(job.message),
              text: job.message,
              directory: job.directory,
              origin: job.origin,
            }).catch(() => {})
            return { content: `Scheduled ${job.id} for ${stamp(job.fireAt)} (in ${until(job.fireAt)}).` }
          }

          if (action === "list") {
            const jobs = (await listJobs(context.sessionID))
              .filter((job) => originOf(job) === "agent")
              .sort((a, b) => a.fireAt - b.fireAt)
            if (jobs.length === 0) return { content: "No delayed messages scheduled by you in this session." }
            return {
              content: [
                `You have ${jobs.length} delayed message${jobs.length === 1 ? "" : "s"} in this session:`,
                ...jobs.map(
                  (job) => `- ${job.id} — ${stamp(job.fireAt)} (in ${until(job.fireAt)}): ${previewOf(job.message)}`,
                ),
              ].join("\n"),
            }
          }

          if (action === "cancel") {
            if (!id) return { content: "Error: id is required for cancel." }
            const stored = (await ctx.storage.get(key(id))) as Job | undefined
            if (!stored || stored.sessionID !== context.sessionID || originOf(stored) !== "agent")
              return { content: `Error: no delayed message scheduled by you with id ${id} in this session.` }
            const job = await withdraw(context.sessionID, id)
            if (!job) return { content: `Error: message ${id} is no longer pending.` }
            return { content: `Cancelled ${id}.` }
          }

          return { content: "Error: action must be schedule, list, or cancel." }
        },
      })
    })

    // A command error returns to the client that ran it: the composer shows a
    // toast and restores the text, so a bad schedule never enters the session.
    await ctx.command.transform((editor) => {
      editor.add({
        name: "delayed",
        description: "Wake this session later with a message",
        execute: async ({ sessionID, prompt }) => {
          const raw = prompt.text.trim()
          const first = /^(\S+)(?:\s+|$)/.exec(raw)
          const when = first?.[1] ?? ""
          let rest = raw.slice(first?.[0].length ?? 0)

          let time = when
          const second = /^(\S+)/.exec(rest)?.[1]
          if (/^\d{4}-\d{2}-\d{2}$/.test(when) && second && /^\d{1,2}:\d{2}(:\d{2})?$/.test(second)) {
            time = `${when}T${second}`
            rest = rest.slice(second.length)
          }

          const message = rest.trim()
          if (!time || !message)
            throw new Error(
              "Usage: /delayed <time> <message> — time: HH:MM, YYYY-MM-DDTHH:MM, or 30m / 2h / 1d.",
            )

          const now = Date.now()
          const at = resolveTime(time, now)
          if (typeof at === "string") throw new Error(`Delayed message not scheduled: ${at}.`)

          const job: Job = {
            id: crypto.randomUUID(),
            sessionID,
            message,
            fireAt: at,
            directory: ctx.location.directory,
            origin: "user",
          }
          await ctx.storage.set(key(job.id), job)
          arm(job)
          await rpc.events.emit("scheduled", {
            sessionID,
            id: job.id,
            fireAt: at,
            preview: previewOf(message),
            text: message,
            directory: job.directory,
            origin: job.origin,
          }).catch(() => {})
        },
      })
    })

    let after: string | undefined
    do {
      const page = await ctx.storage.scan(after ? { prefix: "pending/", after } : { prefix: "pending/" })
      for (const entry of page.entries) {
        const job = entry.value as Job
        if (!job?.id || !job.sessionID || !job.message || !job.fireAt) continue
        if (job.directory !== ctx.location.directory) continue
        arm(job)
      }
      after = page.next
    } while (after)

    return () => {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
    }
  },
})
