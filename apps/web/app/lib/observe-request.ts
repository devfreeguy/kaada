/** Subscribe to a read without allowing a stale completion to update an unmounted flow. */
export function observeRequest<T>(
  read: () => Promise<T>,
  resolve: (value: T) => void,
  reject: (error: unknown) => void,
) {
  let active = true;
  void read().then(
    (value) => {
      if (active) resolve(value);
    },
    (error) => {
      if (active) reject(error);
    },
  );
  return () => {
    active = false;
  };
}
