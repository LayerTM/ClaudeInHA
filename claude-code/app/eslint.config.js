'use strict';

// Lean ESLint config for the add-on's Node/CommonJS prompt server + browser
// console frontend. Goal: catch REAL bugs (undefined vars, unused vars, unsafe
// shadowing, unreachable code, obviously wrong types) — NOT restyle
// hand-written code. Deliberately no stylistic/formatting rules (semi, quotes,
// indent, etc.) and no-await-in-loop stays OFF: the server awaits in loops on
// purpose (bounded retry / snapshot resize / discovery backoff).

const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  {
    ignores: ['node_modules/**', 'public/vendor/**'],
  },

  {
    // The source deliberately keeps `// eslint-disable-next-line no-await-in-loop`
    // and `no-nested-ternary` markers documenting conscious overrides for the
    // stricter (airbnb-style) ruleset it was written against. We intentionally do
    // NOT enable those opinionated rules here, so treat those directives as inert
    // documentation rather than churning hand-written files to strip them.
    linterOptions: {
      reportUnusedDisableDirectives: 'off',
    },
  },

  js.configs.recommended,

  // Server + tests + fixtures: Node, CommonJS.
  {
    files: ['server/**/*.js', 'test/**/*.js', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // Catch typos / dead bindings. Ignore intentionally-unused args that only
      // exist to satisfy a fixed callback arity (e.g. Express error handlers
      // need the 4th `next` arg), and leading-underscore throwaways.
      'no-unused-vars': ['error', {
        args: 'after-used',
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrors: 'none',
      }],
      // Shadowing a variable from an outer scope is a common source of subtle
      // bugs; flag it (allow shadowing globals like `name`/`event` that aren't
      // referenced here anyway).
      'no-shadow': 'error',
    },
  },

  // Browser frontend: classic script (IIFE), served straight to the page.
  {
    files: ['public/**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      'no-unused-vars': ['error', {
        args: 'after-used',
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrors: 'none',
      }],
      'no-shadow': 'error',
    },
  },
];
