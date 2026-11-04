import { createSignal, For } from "solid-js"
import { ComposerPill, createKeyed, Plugin, Style } from "@opencode/plugin/gui"
import { Delayed } from "./rpc"

type Job = { id: string; fireAt: number; preview: string }

const css = `
.dm { display: flex; flex-direction: column; min-width: 280px; max-width: 440px; }
.dm-row { display: flex; align-items: center; gap: 8px; padding: 8px 2px; }
.dm-row + .dm-row { border-top: 1px solid color-mix(in srgb, currentColor 12%, transparent); }
.dm-body { flex: 1; min-width: 0; }
.dm-when { display: flex; align-items: baseline; gap: 8px; font-variant-numeric: tabular-nums; }
.dm-left { opacity: .55; font-size: 12px; white-space: nowrap; }
.dm-text { opacity: .72; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dm-x { flex: none; width: 22px; height: 22px; border: 0; border-radius: 6px; background: transparent; color: inherit; opacity: .45; cursor: pointer; font: inherit; line-height: 1; }
.dm-x:hover { opacity: 1; background: color-mix(in srgb, currentColor 14%, transparent); }
`

export default Plugin.define({
  i18n: {
    en: {
      "pill.one": "Scheduled · {{time}}",
      "pill.many": "Scheduled: {{count}}",
      "menu.title": "Scheduled messages",
      "row.cancel": "Cancel",
      "left.now": "now",
      "left.days": "in {{days}}d {{hours}}h",
      "left.hours": "in {{hours}}h {{minutes}}m",
      "left.minutes": "in {{minutes}}m",
    },
    ru: {
      "pill.one": "Отложенное · {{time}}",
      "pill.many": "Отложенных: {{count}}",
      "menu.title": "Отложенные сообщения",
      "row.cancel": "Отменить",
      "left.now": "сейчас",
      "left.days": "через {{days}} д {{hours}} ч",
      "left.hours": "через {{hours}} ч {{minutes}} мин",
      "left.minutes": "через {{minutes}} мин",
    },
    de: {
      "pill.one": "Geplant · {{time}}",
      "pill.many": "Geplant: {{count}}",
      "menu.title": "Geplante Nachrichten",
      "row.cancel": "Abbrechen",
      "left.now": "jetzt",
      "left.days": "in {{days}} T {{hours}} Std.",
      "left.hours": "in {{hours}} Std. {{minutes}} Min.",
      "left.minutes": "in {{minutes}} Min.",
    },
    fr: {
      "pill.one": "Programmé · {{time}}",
      "pill.many": "Programmés : {{count}}",
      "menu.title": "Messages programmés",
      "row.cancel": "Annuler",
      "left.now": "maintenant",
      "left.days": "dans {{days}} j {{hours}} h",
      "left.hours": "dans {{hours}} h {{minutes}} min",
      "left.minutes": "dans {{minutes}} min",
    },
    zh: {
      "pill.one": "已安排 · {{time}}",
      "pill.many": "已安排：{{count}}",
      "menu.title": "已安排的消息",
      "row.cancel": "取消",
      "left.now": "现在",
      "left.days": "还有 {{days}} 天 {{hours}} 小时",
      "left.hours": "还有 {{hours}} 小时 {{minutes}} 分钟",
      "left.minutes": "还有 {{minutes}} 分钟",
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
          label:
            list.length === 1
              ? ctx.t("pill.one", { time: clock(list[0].fireAt) })
              : ctx.t("pill.many", { count: list.length }),
          icon: "notifications",
          title: ctx.t("menu.title"),
        }
      },
      menu: (props) => (
        <div class="dm">
          <For each={jobs()[props.session.id] ?? []}>
            {(job) => (
              <div class="dm-row">
                <div class="dm-body">
                  <div class="dm-when">
                    <span>{when(job.fireAt)}</span>
                    <span class="dm-left">{left(job.fireAt)}</span>
                  </div>
                  <div class="dm-text">{job.preview}</div>
                </div>
                <button
                  class="dm-x"
                  title={ctx.t("row.cancel")}
                  aria-label={ctx.t("row.cancel")}
                  onClick={() => void cancel(props.session.id, job.id)}
                >
                  ×
                </button>
              </div>
            )}
          </For>
        </div>
      ),
    })
  },
})
