// TUI plugins installed from npm otherwise keep their own Solid runtime, so
// signals created here never reach the host renderer. Import the host's
// modules through the OpenTUI runtime ids and build the tree with jsx() so the
// host's reactive graph owns every expression (OpenCode issue #39986).
import type { Plugin } from "@opencode/plugin/tui"
import { createEffect, createSignal, onCleanup } from "opentui:runtime-module:solid-js"
import { jsx } from "opentui:runtime-module:%40opentui%2Fsolid%2Fjsx-runtime"
import { Delayed } from "./rpc"

type Pending = {
  id: string
  fireAt: number
  preview: string
  text: string
  origin?: "user" | "agent"
}

const h = jsx as unknown as (type: any, props: Record<string, any>, key?: any) => any

const pad = (value: number) => String(value).padStart(2, "0")

const clock = (at: number) => {
  const date = new Date(at)
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

const when = (at: number) => {
  const date = new Date(at)
  const today = new Date()
  return date.toDateString() === today.toDateString()
    ? clock(at)
    : `${pad(date.getDate())}.${pad(date.getMonth() + 1)} ${clock(at)}`
}

const left = (at: number) => {
  const ms = at - Date.now()
  if (ms <= 0) return "now"
  const minutes = Math.ceil(ms / 60_000)
  const hours = Math.floor(minutes / 60)
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`
  if (hours > 0) return `${hours}h ${minutes % 60}m`
  return `${minutes}m`
}

const draftTime = (at: number) => {
  const date = new Date(at)
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`
  return date.getSeconds() === 0 ? `${day}T${time}` : `${day}T${time}:${pad(date.getSeconds())}`
}

export default {
  id: "delayed-message.tui",
  setup(context: Plugin.Context) {
    const rpc = context.client.rpc(Delayed)
    const [jobs, setJobs] = createSignal<Record<string, Pending[]>>({})

    const location = (sessionID: string) => {
      const directory = context.data.session.get(sessionID)?.location.directory ?? context.location?.directory
      return directory ? { location: { directory } } : undefined
    }

    const invalidate = (sessionID: string) => {
      context.data.session.pending.invalidate(sessionID)
      context.data.session.invalidate(sessionID)
    }

    const load = (sessionID: string, directory?: string) => {
      const options = directory ? { location: { directory } } : location(sessionID)
      return rpc
        .pending({ sessionID }, options)
        .then((value) => {
          const { jobs: list } = value as { jobs: Pending[] }
          setJobs((prev) => ({ ...prev, [sessionID]: list }))
          invalidate(sessionID)
        })
        .catch(() => {})
    }

    const put = (sessionID: string, job: Pending) => {
      setJobs((prev) => ({
        ...prev,
        [sessionID]: [...(prev[sessionID] ?? []).filter((item) => item.id !== job.id), job].sort(
          (a, b) => a.fireAt - b.fireAt,
        ),
      }))
      invalidate(sessionID)
    }

    const drop = (sessionID: string, id: string) => {
      setJobs((prev) => ({
        ...prev,
        [sessionID]: (prev[sessionID] ?? []).filter((item) => item.id !== id),
      }))
      invalidate(sessionID)
    }

    const stops = [
      context.data.on("rpc.delayed-message.scheduled", (event) => {
        const { sessionID, id, fireAt, preview, text, origin } = event.data as {
          sessionID: string
          id: string
          fireAt: number
          preview: string
          text: string
          origin?: "user" | "agent"
        }
        put(sessionID, { id, fireAt, preview, text, origin })
      }),
      context.data.on("rpc.delayed-message.fired", (event) => {
        const { sessionID, id } = event.data as { sessionID: string; id: string }
        drop(sessionID, id)
      }),
      context.data.on("rpc.delayed-message.cancelled", (event) => {
        const { sessionID, id } = event.data as { sessionID: string; id: string }
        drop(sessionID, id)
      }),
    ]

    const apply = async (sessionID: string, id: string, patch: { text?: string; time?: string }) => {
      const result = (await rpc.update({ sessionID, id, ...patch }, location(sessionID))) as {
        ok: boolean
        error?: string
        fireAt?: number
      }
      if (!result.ok) {
        context.ui.toast.show({
          title: "Delayed message not updated",
          message: result.error ?? "Unknown error",
          variant: "error",
        })
        return
      }
      void load(sessionID)
      context.ui.toast.show({ title: "Delayed message", message: "Updated", variant: "success" })
    }

    const cancel = async (sessionID: string, job: Pending) => {
      const confirmed = await context.ui.dialog.confirm({
        title: "Cancel delayed message?",
        message: job.preview,
      })
      if (!confirmed) return
      const { ok } = (await rpc.cancel({ sessionID, id: job.id }, location(sessionID))) as { ok: boolean }
      if (!ok) {
        context.ui.toast.show({
          title: "Delayed message not cancelled",
          message: "It is no longer pending.",
          variant: "warning",
        })
        return
      }
      drop(sessionID, job.id)
      context.ui.toast.show({ title: "Delayed message", message: "Cancelled", variant: "info" })
    }

    const sendNow = async (sessionID: string, job: Pending) => {
      try {
        const { status } = (await rpc.deliver({ sessionID, id: job.id }, location(sessionID))) as {
          status: string
        }
        if (status === "delivered" || status === "missing") {
          drop(sessionID, job.id)
          context.ui.toast.show({
            title: "Delayed message",
            message: status === "delivered" ? "Sent" : "Already sent",
            variant: "success",
          })
          context.ui.dialog.clear()
          return
        }
        context.ui.toast.show({
          title: "Delayed message not sent",
          message: status === "busy" ? "It is already being delivered." : "Delivery failed.",
          variant: "error",
        })
      } catch {
        context.ui.toast.show({
          title: "Delayed message not sent",
          message: "Delivery failed.",
          variant: "error",
        })
      }
    }

    const reschedule = async (sessionID: string, job: Pending) => {
      const time = await context.ui.dialog.prompt({
        title: "New time",
        description: "HH:MM, YYYY-MM-DDTHH:MM, or 30m / 2h / 1d",
        value: draftTime(job.fireAt),
      })
      if (time === undefined) return
      await apply(sessionID, job.id, { time })
    }

    const open = async (sessionID: string) => {
      const list = [...(jobs()[sessionID] ?? [])].sort((a, b) => a.fireAt - b.fireAt)
      if (list.length === 0) return

      const selected = await context.ui.dialog.select<Pending>({
        title: "Delayed messages",
        options: list.map((job) => ({
          title: job.origin === "agent" ? `✦ ${job.preview}` : job.preview,
          description: `${when(job.fireAt)} · ${left(job.fireAt)}`,
          value: job,
        })),
        actions: [
          { bind: "ctrl+x", title: "Cancel", onTrigger: (job) => void cancel(sessionID, job) },
          { bind: "ctrl+t", title: "Reschedule", onTrigger: (job) => void reschedule(sessionID, job) },
          { bind: "ctrl+e", title: "Send now", onTrigger: (job) => void sendNow(sessionID, job) },
        ],
      })
      if (!selected) return

      const text = await context.ui.dialog.prompt({
        title: "Edit delayed message",
        value: selected.text,
      })
      if (text === undefined || text === selected.text) return
      await apply(sessionID, selected.id, { text })
    }

    context.ui.slot({
      append: "session.composer.top",
      render: (props) =>
        h(Pill, {
          context,
          sessionID: props.sessionID,
          jobs,
          load,
          open,
        }),
    })

    return () => {
      for (const stop of stops) stop()
    }
  },
}

function Pill(props: {
  context: Plugin.Context
  sessionID: string
  jobs: () => Record<string, Pending[]>
  load: (sessionID: string, directory?: string) => void
  open: (sessionID: string) => void
}) {
  const [hovered, setHovered] = createSignal(false)
  const count = () => {
    props.context.data.session.get(props.sessionID)
    props.context.data.session.pending.list(props.sessionID)
    return (props.jobs()[props.sessionID] ?? []).length
  }

  const reload = () => {
    const sessionID = props.sessionID
    const directory = props.context.data.session.get(sessionID)?.location.directory
    props.load(sessionID, directory)
  }

  createEffect(reload)
  onCleanup(props.context.data.on("server.connected", reload))

  return h("box", {
    get height() {
      return count() > 0 ? 1 : 0
    },
    flexShrink: 0,
    onMouseOver: () => setHovered(true),
    onMouseOut: () => setHovered(false),
    // The dialog mounts under the cursor; wait for the release that clicked the
    // pill to finish, or it can trigger a footer action (for example Send now).
    onMouseUp: () => setTimeout(() => props.open(props.sessionID), 150),
    get children() {
      return h("text", {
        get fg() {
          return hovered() ? props.context.theme.text.base : props.context.theme.text.muted
        },
        wrapMode: "none",
        get children() {
          const n = count()
          return n > 0 ? `⏰ ${n} delayed` : ""
        },
      })
    },
  })
}
