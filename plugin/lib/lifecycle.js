/** Dispose every owned resource without allowing one failure to strand the rest. */
export async function disposePluginResources(disposers) {
  const errors = [];
  for (const dispose of disposers) {
    try {
      await dispose?.();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length) throw new AggregateError(errors, 'Moments cleanup failed');
}
