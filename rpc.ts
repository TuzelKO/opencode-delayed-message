import { Rpc } from "@opencode/plugin/rpc"

// Bridge between the server plugin and its GUI part: the pill asks `pending`
// on mount, follows `scheduled`/`fired`/`cancelled`, and cancels by id.

const job = {
  type: "object",
  properties: {
    id: { type: "string" },
    fireAt: { type: "number" },
    preview: { type: "string" },
  },
  required: ["id", "fireAt", "preview"],
  additionalProperties: false,
} as const

export const Delayed = Rpc.define({
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
          directory: { type: "string" },
        },
        required: ["sessionID", "id", "fireAt", "preview", "directory"],
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
})
