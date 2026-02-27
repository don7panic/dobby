import { buildProgram } from "./program.js";

/**
 * Runs the CLI entrypoint with the provided argv vector.
 */
export async function runCli(argv = process.argv): Promise<void> {
  const program = buildProgram();
  await program.parseAsync(argv);
}
