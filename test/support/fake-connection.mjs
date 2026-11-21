import { PassThrough } from 'node:stream';

/**
 * A connection double: `request` answers from `answer(input)` and records every call.
 * @param {(input: { method: string; url: string; body?: unknown }) => unknown} answer Response
 *   or a thrown/rejected error.
 * @returns {{ request: Function; calls: Array<{ input: object; options: object }> }} Double.
 */
export function fakeConnection(answer) {
  const calls = [];
  return {
    calls,
    request(input, options) {
      calls.push({ input, options });
      let promise;
      try {
        promise = Promise.resolve(answer(input));
      } catch (error) {
        promise = Promise.reject(error);
      }
      return Object.assign(promise, { stream: () => new PassThrough() });
    },
  };
}
