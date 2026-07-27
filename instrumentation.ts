export function register(): void {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    require("./instrumentation.node");
  }
}
