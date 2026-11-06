import { Plugin } from "@opencode/plugin"
import { Delayed } from "./rpc"

// /delayed <time> <message>
//
// The command is registered by the plugin, so the message never becomes a user
// prompt at scheduling time: it stays inside `execute` and the model sees it
// only when the timer delivers it as a real user prompt.

type Job = {
  id: string
  sessionID: string
  message: string
  fireAt: number
  directory: string
}

const MAX_TIMER = 2 ** 31 - 1
const UNIT_MS: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }

// Setup can run more than once per directory; only the first timer may deliver.
const claimed = new Set<string>()
// Guards concurrent deliveries of one job while the prompt is in flight.
const delivering = new Set<string>()

type Delivery = "delivered" | "busy" | "failed"

const key = (id: string) => `pending/${id}`

const resolveTime = (raw: string, now: number): number | string => {
  const relative = /^\+(\d+)([smhd])$/.exec(raw)
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

const stamp = (at: number) =>
  `${new Date(at).toLocaleString("sv-SE", { hour12: false })} ${Intl.DateTimeFormat().resolvedOptions().timeZone}`

const humanize = (ms: number) => {
  const seconds = Math.max(0, Math.round(ms / 1000))
  const days = Math.floor(seconds / 86_400)
  const hours = Math.floor((seconds % 86_400) / 3_600)
  const minutes = Math.floor((seconds % 3_600) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

const previewOf = (message: string) => message.replace(/\s+/g, " ").trim().slice(0, 120)

export default Plugin.define({
  id: "delayed-message",
  async setup(ctx) {
    const timers = new Map<string, ReturnType<typeof setTimeout>>()

    const rpc = await ctx.rpc.register(Delayed, {
      pending: async (input) => {
        const { sessionID } = input as { sessionID: string }
        const jobs: Array<{ id: string; fireAt: number; preview: string }> = []
        let after: string | undefined
        do {
          const page = await ctx.storage.scan(after ? { prefix: "pending/", after } : { prefix: "pending/" })
          for (const entry of page.entries) {
            const job = entry.value as Job
            if (job?.sessionID !== sessionID || !job.id || !job.fireAt) continue
            jobs.push({ id: job.id, fireAt: job.fireAt, preview: previewOf(job.message) })
          }
          after = page.next
        } while (after)
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
      deliver: async (input) => {
        const { sessionID, id } = input as { sessionID: string; id: string }
        if (claimed.has(id)) return { status: "delivered" }
        if (delivering.has(id)) return { status: "busy" }
        const stored = (await ctx.storage.get(key(id))) as Job | undefined
        if (!stored || stored.sessionID !== sessionID) return { status: "missing" }
        return { status: await deliver(stored) }
      },
    })

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
        await ctx.session.prompt({ sessionID: job.sessionID, text: job.message })
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

    // The GUI pill is the immediate feedback; the note is only a transcript
    // record, so it waits for the next turn instead of waking the model.
    const note = (sessionID: string, text: string) =>
      ctx.session.synthetic({ sessionID, text, resume: false }).catch(() => {})

    // Errors have no pill to lean on, so they drain at once.
    const alert = (sessionID: string, text: string) =>
      ctx.session.synthetic({ sessionID, text, resume: true }).catch(() => {})

    await ctx.command.transform((editor) => {
      editor.add({
        name: "delayed",
        description: "Wake this session later with a message",
        execute: async ({ sessionID, prompt }) => {
          try {
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
            if (!time || !message) {
              await alert(
                sessionID,
                "Usage: /delayed <time> <message>\n" +
                  "Time: HH:MM, YYYY-MM-DDTHH:MM, or +30m / +2h / +1d.",
              )
              return
            }

            const now = Date.now()
            const at = resolveTime(time, now)
            if (typeof at === "string") {
              await alert(sessionID, `Delayed message not scheduled: ${at}.`)
              return
            }

            const job: Job = {
              id: crypto.randomUUID(),
              sessionID,
              message,
              fireAt: at,
              directory: ctx.location.directory,
            }
            await ctx.storage.set(key(job.id), job)
            arm(job)
            await rpc.events.emit("scheduled", {
              sessionID,
              id: job.id,
              fireAt: at,
              preview: previewOf(message),
              directory: job.directory,
            }).catch(() => {})
            await note(sessionID, `Delayed message scheduled for ${stamp(at)} (in ${humanize(at - now)}).`)
          } catch (error) {
            console.error("[delayed-message] schedule failed:", error)
            await alert(sessionID, `Delayed message failed: ${error instanceof Error ? error.message : String(error)}`)
          }
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
