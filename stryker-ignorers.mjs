// A Stryker ignorer plugin (docs/DECISIONS.md D34). It skips mutants in free text
// that is not part of the interface: the `detail` of a reason (docs/REASON_CODES.md
// says so) and the message of a thrown error. Every condition around that text is
// still mutated; only the wording is not.
const ERROR_CLASSES = new Set(['Error', 'TypeError', 'LedgerError', 'VerifierConfigError']);

function isErrorMessage(path) {
  const parent = path.parentPath;
  if (parent === null || path.listKey !== 'arguments') return false;
  const callee = parent.node.callee;
  if (callee?.type !== 'Identifier') return false;
  if (parent.isNewExpression() && ERROR_CLASSES.has(callee.name)) return true;
  // verifier.ts: fail(message) throws a VerifierConfigError with that message.
  return parent.isCallExpression() && callee.name === 'fail';
}

export const strykerPlugins = [
  {
    kind: 'Ignore',
    name: 'free-text',
    value: {
      shouldIgnore(path) {
        if (
          path.isObjectProperty() &&
          !path.node.computed &&
          path.node.key.type === 'Identifier' &&
          path.node.key.name === 'detail'
        ) {
          return 'A reason detail is free text, not part of the stable interface.';
        }
        if (isErrorMessage(path)) return 'An error message is free text.';
        return undefined;
      },
    },
  },
];
