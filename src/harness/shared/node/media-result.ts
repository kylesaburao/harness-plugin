export interface MediaProcessResult {
  code: number | null;
  signal?: string | null | undefined;
  stderr?: string | undefined;
}

// For existing media commands where stderr is failure evidence, not a universal
// subprocess-success predicate.
export function mediaFailed(result: MediaProcessResult): boolean {
  return result.code !== 0 ||
    Boolean(result.signal) ||
    Boolean(result.stderr?.trim());
}

export function childDetails(task: string, result: MediaProcessResult) {
  return {
    task,
    childExitCode: result.code,
    childSignal: result.signal ?? null,
    stderr: result.stderr,
  };
}
