import Prism from 'prismjs';
import loadLanguages from 'prismjs/components/index.js';

loadLanguages(['sql']);

const sqlWithConfig = {
  'config-section': {
    pattern: /^config:[\s\S]*$/m,
    inside: {
      'config-delimiter': /^config:/m,
      'config-key': {
        pattern: /^[a-zA-Z][a-zA-Z0-9_-]*(?=\s*:)/m,
        alias: 'property'
      },
      'config-value': {
        pattern: /:\s*.+$/m,
        inside: {
          'punctuation': /^:/,
          'color': /rgba?\([^)]+\)|#[0-9a-fA-F]{3,8}/,
          'number': /\b\d+(\.\d+)?(%|px|em|rem)?\b/,
          'boolean': /\b(true|false)\b/i,
          'string': /.+/
        }
      }
    }
  },
  'template-section': {
    pattern: /^template:[\s\S]*$/m,
    inside: {
      'template-delimiter': /^template:/m,
      'template-code': /[\s\S]+/
    }
  },
  ...Prism.languages.sql
};

const GRAMMARS = {
  'vaultquery': sqlWithConfig,
  'vaultquery-chart': sqlWithConfig,
  'vaultquery-markdown': sqlWithConfig,
  'vaultquery-calendar': sqlWithConfig,
  'vaultquery-write': Prism.languages.sql,
  'vaultquery-view': Prism.languages.sql,
  'vaultquery-trigger': Prism.languages.sql,
  'vaultquery-function': Prism.languages.javascript,
};

export function covers(language) {
  return language in GRAMMARS;
}

export function grammarFor(language) {
  return GRAMMARS[language];
}
