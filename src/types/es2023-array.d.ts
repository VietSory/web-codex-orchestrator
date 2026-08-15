// Node.js 22 provides Array.prototype.findLast at runtime. The project targets
// an older standard library surface for broad package compatibility, so declare
// only the built-in signature WCO uses without changing the global tsconfig.
interface Array<T> {
  findLast(
    predicate: (value: T, index: number, array: T[]) => unknown,
    thisArg?: unknown,
  ): T | undefined;
}
