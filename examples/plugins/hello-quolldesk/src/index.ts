import { definePlugin } from "@quolldesk/plugin-sdk";

export default definePlugin({
  activate(context) {
    context.logger.info("Hello QuollDesk example activated", {
      pluginId: context.pluginId,
    });
    context.subscriptions.add(context.commands.registerCommand(
      "com.quolldesk.hello.sayHello",
      async () => {
        const greeting = await context.settings.get<string>("com.quolldesk.hello.greeting");
        context.logger.info(greeting ?? "Hello from QuollDesk");
        return { greeting: greeting ?? "Hello from QuollDesk" };
      },
    ));
    context.subscriptions.add(context.providers.register(
      "com.quolldesk.hello.completion",
      "terminal.completion",
      ({ payload }) => {
        const { input } = payload;
        return input && "quolldesk-hello".startsWith(input)
          ? { items: [{ text: "quolldesk-hello", score: 5_000 }] }
          : { items: [] };
      },
    ));
    context.subscriptions.add(context.providers.register(
      "com.quolldesk.hello.decoration",
      "terminal.decoration",
      () => ({
        rules: [{
          id: "greeting",
          label: "QuollDesk greeting",
          patterns: ["\\bHello from QuollDesk\\b"],
          color: "#34D399",
        }],
      }),
    ));
    context.subscriptions.add(context.providers.register(
      "com.quolldesk.hello.theme",
      "terminal.theme",
      () => ({ colors: { cursor: "#34D399" } }),
    ));
  },
});
