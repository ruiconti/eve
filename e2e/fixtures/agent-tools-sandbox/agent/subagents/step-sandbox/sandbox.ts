import { defineSandbox } from "eve/sandbox";
import { JustBashSandbox } from "eve/sandbox/just-bash";
import { VercelSandbox } from "eve/sandbox/vercel";

// Workflow steps reach the session's sandbox only on providers that reopen it
// by session id, so this child pins one in every world.
export const environment = process.env.VERCEL
  ? VercelSandbox.environment()
  : JustBashSandbox.environment();

export default defineSandbox(() => environment.open());
