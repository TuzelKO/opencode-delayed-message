import { createSignal, For } from "solid-js"
import { Schema } from "effect"
import { ComposerPill, createKeyed, Plugin, Style } from "@opencode/plugin/gui"
import { Delayed } from "./rpc"

type Job = { id: string; fireAt: number; preview: string }

const MaxTimer = 2 ** 31 - 1

const pad = (value: number) => String(value).padStart(2, "0")

// Local wall-clock time in the command's ISO form, seconds only when they are
// not zero so a relative schedule keeps its exact target.
const draftTime = (at: number) => {
  const date = new Date(at)
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  return date.getSeconds() === 0 ? `${day}T${time}` : `${day}T${time}:${pad(date.getSeconds())}`
}

const css = `
[data-slot="session-plugin-pill-popover"]:has(.dm) > div:first-child { display: none; }
.dm { display: flex; flex-direction: column; gap: 1px; }
.dm:focus { outline: none; }
.dm-row { position: relative; display: flex; align-items: center; gap: 8px; height: 28px; padding: 0 6px 0 12px; border-radius: 4px; font-size: 13px; font-weight: 440; line-height: var(--line-height-compact); letter-spacing: -.04px; }
.dm-row:hover { background: var(--v2-overlay-simple-overlay-hover); }
.dm-time { flex: none; font-weight: 530; font-variant-numeric: tabular-nums; }
.dm-text { flex: 1 1 auto; min-width: 0; color: var(--v2-text-text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dm-left { flex: none; min-width: 52px; text-align: right; color: var(--v2-text-text-muted); font-size: 11px; font-weight: 440; letter-spacing: .05px; font-variant-numeric: tabular-nums; white-space: nowrap; transition: opacity .12s ease; }
.dm-actions { position: absolute; right: 6px; top: 50%; transform: translateY(-50%); display: flex; gap: 2px; opacity: 0; pointer-events: none; transition: opacity .12s ease; }
.dm-row:hover .dm-left, .dm-row:has(.dm-action:focus-visible) .dm-left { opacity: 0; }
.dm-row:hover .dm-actions, .dm-row:has(.dm-action:focus-visible) .dm-actions { opacity: 1; pointer-events: auto; }
.dm-action { flex: none; width: 22px; height: 22px; border: 0; border-radius: 4px; background: transparent; color: inherit; opacity: .55; cursor: pointer; font: inherit; line-height: 1; }
.dm-action:hover { opacity: 1; background: var(--v2-overlay-simple-overlay-hover); }
`

export default Plugin.define({
  i18n: {
    en: {
      "pill.label": "Delayed",
      "menu.title": "Scheduled messages",
      "row.cancel": "Cancel",
      "row.edit": "Edit",
      "left.now": "now",
      "left.days": "{{days}}d {{hours}}h",
      "left.hours": "{{hours}}h {{minutes}}m",
      "left.minutes": "{{minutes}}m",
    },
    ru: {
      "pill.label": "Отложенное",
      "menu.title": "Отложенные сообщения",
      "row.cancel": "Отменить",
      "row.edit": "Изменить",
      "left.now": "сейчас",
      "left.days": "{{days}} д {{hours}} ч",
      "left.hours": "{{hours}} ч {{minutes}} мин",
      "left.minutes": "{{minutes}} мин",
    },
    de: {
      "pill.label": "Geplant",
      "menu.title": "Geplante Nachrichten",
      "row.cancel": "Abbrechen",
      "row.edit": "Bearbeiten",
      "left.now": "jetzt",
      "left.days": "{{days}} T {{hours}} Std.",
      "left.hours": "{{hours}} Std. {{minutes}} Min.",
      "left.minutes": "{{minutes}} Min.",
    },
    fr: {
      "pill.label": "Programmé",
      "menu.title": "Messages programmés",
      "row.cancel": "Annuler",
      "row.edit": "Modifier",
      "left.now": "maintenant",
      "left.days": "{{days}} j {{hours}} h",
      "left.hours": "{{hours}} h {{minutes}} min",
      "left.minutes": "{{minutes}} min",
    },
    zh: {
      "pill.label": "已安排",
      "menu.title": "已安排的消息",
      "row.cancel": "取消",
      "row.edit": "编辑",
      "left.now": "现在",
      "left.days": "{{days}} 天 {{hours}} 小时",
      "left.hours": "{{hours}} 小时 {{minutes}} 分钟",
      "left.minutes": "{{minutes}} 分钟",
    },
  },
  setup(ctx) {
    const [jobs, setJobs] = createSignal<Record<string, Job[]>>({})

    const put = (sessionID: string, job: Job) =>
      setJobs((prev) => ({
        ...prev,
        [sessionID]: [...(prev[sessionID] ?? []).filter((item) => item.id !== job.id), job].sort(
          (a, b) => a.fireAt - b.fireAt,
        ),
      }))

    const drop = (sessionID: string, id: string) =>
      setJobs((prev) => ({
        ...prev,
        [sessionID]: (prev[sessionID] ?? []).filter((item) => item.id !== id),
      }))

    const clock = (at: number) =>
      new Date(at).toLocaleTimeString(ctx.locale.locale(), { hour: "2-digit", minute: "2-digit" })

    const day = (at: number) =>
      new Date(at).toLocaleDateString(ctx.locale.locale(), { day: "2-digit", month: "2-digit" })

    const when = (at: number) => {
      const target = new Date(at)
      const today = new Date()
      const time = clock(at)
      return target.toDateString() === today.toDateString() ? time : `${day(at)} ${time}`
    }

    const left = (at: number) => {
      const ms = at - Date.now()
      if (ms <= 0) return ctx.t("left.now")
      const minutes = Math.ceil(ms / 60_000)
      const hours = Math.floor(minutes / 60)
      const days = Math.floor(hours / 24)
      if (days > 0) return ctx.t("left.days", { days, hours: hours % 24 })
      if (hours > 0) return ctx.t("left.hours", { hours, minutes: minutes % 60 })
      return ctx.t("left.minutes", { minutes })
    }

    const rpc = ctx.client.rpc(Delayed)

    rpc.events.on("scheduled", (event) => {
      put(event.data.sessionID, {
        id: event.data.id,
        fireAt: event.data.fireAt,
        preview: event.data.preview,
      })
    })
    rpc.events.on("fired", (event) => {
      drop(event.data.sessionID, event.data.id)
    })
    rpc.events.on("cancelled", (event) => {
      drop(event.data.sessionID, event.data.id)
    })

    const cancel = async (sessionID: string, id: string) => {
      try {
        const { ok } = await rpc.cancel({ sessionID, id })
        if (ok) drop(sessionID, id)
      } catch {}
    }

    createKeyed(
      () => ctx.sessions.current()?.id,
      (sessionID) => {
        void rpc
          .pending({ sessionID })
          .then(({ jobs: list }) => setJobs((prev) => ({ ...prev, [sessionID]: list })))
          .catch(() => {})
      },
    )

    ctx.add(Style, css)

    ctx.add(ComposerPill, {
      id: "pending",
      show(input) {
        const list = jobs()[input.session.id] ?? []
        if (list.length === 0) return undefined

        return {
          label: ctx.t("pill.label"),
          icon: "notifications",
          title: ctx.t("menu.title"),
        }
      },
      menu: (props) => (
        <div class="dm" tabIndex={0}>
          <For each={jobs()[props.session.id] ?? []}>
            {(job) => (
              <div class="dm-row">
                <span class="dm-time">{when(job.fireAt)}</span>
                <span class="dm-text">{job.preview}</span>
                <span class="dm-left">{left(job.fireAt)}</span>
                <span class="dm-actions">
                  <button
                    class="dm-action"
                    title={ctx.t("row.edit")}
                    aria-label={ctx.t("row.edit")}
                    onClick={() => {
                      void rpc
                        .edit({ sessionID: props.session.id, id: job.id })
                        .then(({ ok, text, fireAt }) => {
                          if (!ok || text === undefined || fireAt === undefined) return
                          drop(props.session.id, job.id)
                          props.screen.composer.setText(`/delayed-message ${draftTime(fireAt)} ${text}`)
                          props.close()
                          props.screen.composer.focus()
                        })
                        .catch(() => {})
                    }}
                  >
                    ✎
                  </button>
                  <button
                    class="dm-action"
                    title={ctx.t("row.cancel")}
                    aria-label={ctx.t("row.cancel")}
                    onClick={() => void cancel(props.session.id, job.id)}
                  >
                    ×
                  </button>
                </span>
              </div>
            )}
          </For>
        </div>
      ),
    })
  },
  // The server timer lives in a location service, and an idle location is
  // evicted after 60 minutes; its cleanup takes every pending timer with it.
  // The desktop app's main process outlives locations, so it keeps the clock
  // and asks the location to deliver when the time comes.
  main(ctx) {
    const PendingSchema = Schema.Struct({
      id: Schema.String,
      sessionID: Schema.String,
      directory: Schema.String,
      fireAt: Schema.Number,
    })
    type PendingJob = typeof PendingSchema.Type

    const jobs = ctx.storage.store("pending", { schema: Schema.Array(PendingSchema), initial: [] })
    const timers = new Map<string, ReturnType<typeof setTimeout>>()
    const failures = new Map<string, number>()

    const stop = (id: string) => {
      const timer = timers.get(id)
      if (timer) clearTimeout(timer)
      timers.delete(id)
    }

    const forget = (id: string) => {
      stop(id)
      failures.delete(id)
      if (jobs.value.some((job) => job.id === id)) jobs.set(jobs.value.filter((job) => job.id !== id))
    }

    const arm = (job: PendingJob) => {
      stop(job.id)
      const delay = job.fireAt - Date.now()
      if (delay > MaxTimer - 1) {
        timers.set(job.id, setTimeout(() => arm(job), MaxTimer - 1))
        return
      }
      timers.set(job.id, setTimeout(() => void fire(job), Math.max(0, delay)))
    }

    const fire = async (job: PendingJob) => {
      stop(job.id)
      if (Date.now() < job.fireAt) {
        arm(job)
        return
      }
      try {
        const { status } = await ctx.client.rpc(Delayed).deliver(
          { sessionID: job.sessionID, id: job.id },
          { location: { directory: job.directory } },
        )
        if (status === "delivered" || status === "missing") {
          failures.delete(job.id)
          forget(job.id)
          return
        }
        if (status === "failed") {
          const count = (failures.get(job.id) ?? 0) + 1
          if (count >= 5) {
            failures.delete(job.id)
            forget(job.id)
            return
          }
          failures.set(job.id, count)
        }
        timers.set(job.id, setTimeout(() => void fire(job), status === "busy" ? 2_000 : 30_000))
      } catch {
        timers.set(job.id, setTimeout(() => void fire(job), 15_000))
      }
    }

    const upsert = (job: PendingJob) => {
      jobs.set([...jobs.value.filter((item) => item.id !== job.id), job])
      arm(job)
    }

    const handle = (event: { type: string; data?: unknown }) => {
      if (event.type === "rpc.delayed-message.scheduled") {
        const data = event.data as
          | { id?: string; sessionID?: string; fireAt?: number; directory?: string }
          | undefined
        if (!data?.id || !data.sessionID || !data.fireAt || !data.directory) return
        upsert({ id: data.id, sessionID: data.sessionID, directory: data.directory, fireAt: data.fireAt })
        return
      }
      if (event.type === "rpc.delayed-message.fired" || event.type === "rpc.delayed-message.cancelled") {
        const data = event.data as { id?: string } | undefined
        if (data?.id) forget(data.id)
      }
    }

    for (const job of jobs.value) arm(job)

    void (async () => {
      while (!ctx.signal.aborted) {
        try {
          for await (const event of ctx.client.event.subscribe({ signal: ctx.signal })) handle(event)
        } catch {}
        if (ctx.signal.aborted) break
        await new Promise((resolve) => setTimeout(resolve, 3_000))
      }
    })()

    ctx.onCleanup(() => {
      for (const timer of timers.values()) clearTimeout(timer)
      timers.clear()
    })
  },
})
