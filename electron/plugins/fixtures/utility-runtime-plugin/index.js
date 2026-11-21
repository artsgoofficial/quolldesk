import { definePlugin } from "@quolldesk/plugin-sdk";

export default definePlugin({
  async activate(context) {
    await context.storage.set("smoke.activation", { kind: "utility", ready: true });
  },
});
