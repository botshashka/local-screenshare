// The four pure reducers (sender/receiver × session/controller) all share the
// shape (state, event) => { state, actions }. Driving them in tests needs the same
// two helpers every time — fold a sequence of events to the final state, and read
// the actions a single event emits — so they live here once instead of being
// re-pasted per file. (Reducer-specific accessors like `epochOf` stay local to
// their test, since they reach into each reducer's own state shape.)
export function harness<S, E, A>(reduce: (state: S, event: E) => { state: S; actions: A[] }) {
  return {
    drive: (state: S, ...events: E[]): S =>
      events.reduce((acc, e) => reduce(acc, e).state, state),
    actionsFor: (state: S, event: E): A[] => reduce(state, event).actions,
  };
}
