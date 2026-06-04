import next from "eslint-config-next";

// Next 16 removed `next lint`; we lint via the ESLint CLI with Next's flat config.
export default [
  { ignores: [".next/**", "next-env.d.ts"] },
  ...next,
  {
    // eslint-config-next@16 enables the React Compiler diagnostics (react-hooks
    // v6) that `next lint` never ran. They flag a few intentional patterns here
    // (a Math.random() slug, a window.location hard reload, setState in an
    // effect). Keep them as warnings - surfaced, not blocking - to address on
    // their own rather than as behavioral changes inside the lint migration.
    // The classic react-hooks/rules-of-hooks + exhaustive-deps stay as errors.
    rules: {
      "react-hooks/purity": "warn",
      "react-hooks/immutability": "warn",
      "react-hooks/set-state-in-effect": "warn",
    },
  },
];
