import { definePlugin } from "@quolldesk/plugin-sdk";

export default definePlugin({
  activate(context) {
    context.subscriptions.add(context.commands.registerCommand(
      "com.quolldesk.starter.greet",
      async () => {
        const greeting = await context.settings.get<string>("com.quolldesk.starter.greeting") ?? "Hello, synthetic world!";
        context.views.postMessage("com.quolldesk.starter.panel", { greeting });
        return { greeting };
      },
    ));
  },
});
