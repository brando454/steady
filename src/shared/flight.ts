/** Lets one async action run. A second start is ignored until finish. */
export function createFlightGuard() {
  let active = false;
  return {
    tryStart(): boolean {
      if (active) return false;
      active = true;
      return true;
    },
    finish(): void {
      active = false;
    },
  };
}
