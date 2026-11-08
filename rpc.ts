import type { Rpc } from "@opencode/plugin/rpc"

// Bridge between the server plugin and its TUI/GUI parts: the pill asks
// `pending` on mount, follows `scheduled`/`fired`/`cancelled`, and cancels or
// updates by id.

const job = {
  type: "object",
  properties: {
    id: { type: "string" },
    fireAt: { type: "number" },
    preview: { type: "string" },
    text: { type: "string" },
    origin: { type: "string", enum: ["user", "agent"] },
  },
  required: ["id", "fireAt", "preview", "text"],
  additionalProperties: false,
} as const

export const Delayed = {
  id: "delayed-message",
  methods: {
    pending: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          jobs: { type: "array", items: job },
        },
        required: ["jobs"],
        additionalProperties: false,
      },
    },
    cancel: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          id: { type: "string" },
        },
        required: ["sessionID", "id"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
        additionalProperties: false,
      },
    },
    // The desktop app's main process owns a timer outside the location, so it
    // can ask for delivery after the location that scheduled the job was
    // evicted. Status is "delivered" | "missing" | "busy" | "failed".
    deliver: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          id: { type: "string" },
        },
        required: ["sessionID", "id"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: { status: { type: "string" } },
        required: ["status"],
        additionalProperties: false,
      },
    },
    // Cancels the job and hands its full text back so the pill can put the
    // command into the composer for editing.
    edit: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          id: { type: "string" },
        },
        required: ["sessionID", "id"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          text: { type: "string" },
          fireAt: { type: "number" },
        },
        required: ["ok"],
        additionalProperties: false,
      },
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
          time: { type: "string" },
        },
        required: ["sessionID", "id"],
        additionalProperties: false,
      },
      output: {
        type: "object",
        properties: {
          ok: { type: "boolean" },
          error: { type: "string" },
          fireAt: { type: "number" },
        },
        required: ["ok"],
        additionalProperties: false,
      },
    },
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
          directory: { type: "string" },
          origin: { type: "string", enum: ["user", "agent"] },
        },
        required: ["sessionID", "id", "fireAt", "preview", "text", "directory"],
        additionalProperties: false,
      },
    },
    fired: {
      schema: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          id: { type: "string" },
        },
        required: ["sessionID", "id"],
        additionalProperties: false,
      },
    },
    cancelled: {
      schema: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          id: { type: "string" },
        },
        required: ["sessionID", "id"],
        additionalProperties: false,
      },
    },
  },
} as const satisfies Rpc.PortableDefinition
