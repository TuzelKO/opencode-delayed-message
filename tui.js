// tui.tsx
import { createEffect, createSignal, onCleanup, Show } from "solid-js";

// rpc.ts
import { Rpc } from "@opencode/plugin/rpc";
var job = {
  type: "object",
  properties: {
    id: { type: "string" },
    fireAt: { type: "number" },
    preview: { type: "string" },
    text: { type: "string" }
  },
  required: ["id", "fireAt", "preview", "text"],
  additionalProperties: false
};
var Delayed = Rpc.define({
  id: "delayed-message",
  methods: {
    pending: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false
      },
      output: {
        type: "object",
        properties: {
          jobs: { type: "array", items: job }
        },
        required: ["jobs"],
        additionalProperties: false
      }
    },
    cancel: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          id: { type: "string" }
        },
        required: ["sessionID", "id"],
        additionalProperties: false
      },
      output: {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
        additionalProperties: false
      }
    },
    // The desktop app's main process owns a timer outside the location, so it
    // can ask for delivery after the location that scheduled the job was
    // evicted. Status is "delivered" | "missing" | "busy" | "failed".
    deliver: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          id: { type: "string" }
        },
        required: ["sessionID", "id"],
        additionalProperties: false
      },
      output: {
        type: "object",
        properties: { status: { type: "string" } },
        required: ["status"],
        additionalProperties: false
      }
    },
    // Cancels the job and hands its full text back so the pill can put the
    // command into the composer for editing.
    edit: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          id: { type: "string" }
        },
        required: ["sessionID", "id"],
        additionalProperties: false
      },
      output: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          text: { type: "string" },
          fireAt: { type: "number" }
        },
        required: ["ok"],
        additionalProperties: false
      }
    },
    // Changes the text and/or time of a pending job in place. The TUI edits
    // through this; the job id and its timer stay the same.
    update: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          id: { type: "string" },
          text: { type: "string" },
          time: { type: "string" }
        },
        required: ["sessionID", "id"],
        additionalProperties: false
      },
      output: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          error: { type: "string" },
          fireAt: { type: "number" }
        },
        required: ["ok"],
        additionalProperties: false
      }
    }
  },
  events: {
    scheduled: {
      schema: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          id: { type: "string" },
          fireAt: { type: "number" },
          preview: { type: "string" },
          text: { type: "string" },
          directory: { type: "string" }
        },
        required: ["sessionID", "id", "fireAt", "preview", "text", "directory"],
        additionalProperties: false
      }
    },
    fired: {
      schema: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          id: { type: "string" }
        },
        required: ["sessionID", "id"],
        additionalProperties: false
      }
    },
    cancelled: {
      schema: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          id: { type: "string" }
        },
        required: ["sessionID", "id"],
        additionalProperties: false
      }
    }
  }
});

// tui.tsx
import { jsx } from "@opentui/solid/jsx-runtime";
var pad = (value) => String(value).padStart(2, "0");
var clock = (at) => {
  const date = new Date(at);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
};
var when = (at) => {
  const date = new Date(at);
  const today = /* @__PURE__ */ new Date();
  return date.toDateString() === today.toDateString() ? clock(at) : `${pad(date.getDate())}.${pad(date.getMonth() + 1)} ${clock(at)}`;
};
var left = (at) => {
  const ms = at - Date.now();
  if (ms <= 0) return "now";
  const minutes = Math.ceil(ms / 6e4);
  const hours = Math.floor(minutes / 60);
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return `${minutes}m`;
};
var draftTime = (at) => {
  const date = new Date(at);
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return date.getSeconds() === 0 ? `${day}T${time}` : `${day}T${time}:${pad(date.getSeconds())}`;
};
var tui_default = {
  id: "delayed-message.tui",
  setup(context) {
    const rpc = context.client.rpc(Delayed);
    const [jobs, setJobs] = createSignal({});
    const location = (sessionID) => {
      const directory = context.data.session.get(sessionID)?.location.directory ?? context.location?.directory;
      return directory ? { location: { directory } } : void 0;
    };
    const load = (sessionID, directory) => {
      const options = directory ? { location: { directory } } : location(sessionID);
      return rpc.pending({ sessionID }, options).then((value) => {
        const { jobs: list } = value;
        setJobs((prev) => ({ ...prev, [sessionID]: list }));
      }).catch(() => {
      });
    };
    const put = (sessionID, job2) => setJobs((prev) => ({
      ...prev,
      [sessionID]: [...(prev[sessionID] ?? []).filter((item) => item.id !== job2.id), job2].sort(
        (a, b) => a.fireAt - b.fireAt
      )
    }));
    const drop = (sessionID, id) => setJobs((prev) => ({
      ...prev,
      [sessionID]: (prev[sessionID] ?? []).filter((item) => item.id !== id)
    }));
    const stops = [
      rpc.events.on("scheduled", (event) => {
        const { sessionID, id, fireAt, preview, text } = event.data;
        put(sessionID, { id, fireAt, preview, text });
      }),
      rpc.events.on("fired", (event) => {
        const { sessionID, id } = event.data;
        drop(sessionID, id);
      }),
      rpc.events.on("cancelled", (event) => {
        const { sessionID, id } = event.data;
        drop(sessionID, id);
      })
    ];
    const apply = async (sessionID, id, patch) => {
      const result = await rpc.update({ sessionID, id, ...patch }, location(sessionID));
      if (!result.ok) {
        context.ui.toast.show({
          title: "Delayed message not updated",
          message: result.error ?? "Unknown error",
          variant: "error"
        });
        return;
      }
      void load(sessionID);
      context.ui.toast.show({ title: "Delayed message", message: "Updated", variant: "success" });
    };
    const cancel = async (sessionID, job2) => {
      const confirmed = await context.ui.dialog.confirm({
        title: "Cancel delayed message?",
        message: job2.preview
      });
      if (!confirmed) return;
      const { ok } = await rpc.cancel({ sessionID, id: job2.id }, location(sessionID));
      if (!ok) {
        context.ui.toast.show({
          title: "Delayed message not cancelled",
          message: "It is no longer pending.",
          variant: "warning"
        });
        return;
      }
      drop(sessionID, job2.id);
      context.ui.toast.show({ title: "Delayed message", message: "Cancelled", variant: "info" });
    };
    const reschedule = async (sessionID, job2) => {
      const time = await context.ui.dialog.prompt({
        title: "New time",
        description: "HH:MM, YYYY-MM-DDTHH:MM, or +30m / +2h / +1d",
        value: draftTime(job2.fireAt)
      });
      if (time === void 0) return;
      await apply(sessionID, job2.id, { time });
    };
    const open = async (sessionID) => {
      const list = [...jobs()[sessionID] ?? []].sort((a, b) => a.fireAt - b.fireAt);
      if (list.length === 0) return;
      const selected = await context.ui.dialog.select({
        title: "Delayed messages",
        options: list.map((job2) => ({
          title: job2.preview,
          description: `${when(job2.fireAt)} \xB7 ${left(job2.fireAt)}`,
          value: job2
        })),
        actions: [
          { bind: "ctrl+x", title: "Cancel", onTrigger: (job2) => void cancel(sessionID, job2) },
          { bind: "ctrl+t", title: "Reschedule", onTrigger: (job2) => void reschedule(sessionID, job2) }
        ]
      });
      if (!selected) return;
      const text = await context.ui.dialog.prompt({
        title: "Edit delayed message",
        value: selected.text
      });
      if (text === void 0 || text === selected.text) return;
      await apply(sessionID, selected.id, { text });
    };
    context.ui.slot({
      append: "session.composer.top",
      render: (props) => /* @__PURE__ */ jsx(Pill, { context, sessionID: props.sessionID, jobs, load, open })
    });
    return () => {
      for (const stop of stops) stop();
    };
  }
};
function Pill(props) {
  const [hovered, setHovered] = createSignal(false);
  const list = () => props.jobs()[props.sessionID] ?? [];
  const reload = () => {
    const sessionID = props.sessionID;
    const directory = props.context.data.session.get(sessionID)?.location.directory;
    props.load(sessionID, directory);
  };
  createEffect(reload);
  onCleanup(props.context.data.on("server.connected", reload));
  return /* @__PURE__ */ jsx(Show, { when: list().length > 0, children: /* @__PURE__ */ jsx(
    "box",
    {
      flexShrink: 0,
      onMouseOver: () => setHovered(true),
      onMouseOut: () => setHovered(false),
      onMouseUp: () => props.open(props.sessionID),
      children: /* @__PURE__ */ jsx("text", { fg: hovered() ? props.context.theme.text.base : props.context.theme.text.muted, wrapMode: "none", children: `\u23F0 ${list().length} delayed` })
    }
  ) });
}
export {
  tui_default as default
};
