import type { Extension } from '@codemirror/state';
import { StreamLanguage } from '@codemirror/language';

/** Language id of a file (also what the language servers are keyed by). */
export function languageId(path: string): string {
  let name = (path.split('/').pop() ?? path).toLowerCase();
  // template copies: `.env.example`, `config.php.dist`, `app.ini.sample` are the file they copy
  name = name.replace(/\.(example|sample|dist|template|tpl)$/, '');
  if (name === 'env') name = '.env';
  const ext = name.includes('.') ? name.split('.').pop()! : '';
  if (name === 'dockerfile' || name.startsWith('dockerfile.')) return 'dockerfile';
  if (name === 'makefile' || name === '.bashrc' || name === '.profile') return 'shell';
  if (name === '.env' || name.startsWith('.env.') || name === '.editorconfig' || name === '.gitconfig') return 'properties';
  if (name === 'composer.json' || name === 'package.json' || name === 'tsconfig.json') return 'json';
  switch (ext) {
    case 'ts': case 'mts': case 'cts': return 'typescript';
    case 'tsx': return 'typescriptreact';
    case 'js': case 'mjs': case 'cjs': return 'javascript';
    case 'jsx': return 'javascriptreact';
    case 'json': case 'jsonc': case 'webmanifest': return 'json';
    case 'html': case 'htm': case 'vue': case 'svelte': case 'astro': return 'html';
    case 'css': return 'css';
    case 'scss': case 'sass': return 'scss';
    case 'less': return 'less';
    case 'php': case 'phtml': return 'php';
    case 'py': case 'pyw': return 'python';
    case 'go': return 'go';
    case 'rs': return 'rust';
    case 'java': return 'java';
    case 'kt': case 'kts': return 'kotlin';
    case 'c': case 'h': return 'c';
    case 'cc': case 'cpp': case 'cxx': case 'hpp': case 'hxx': return 'cpp';
    case 'cs': return 'csharp';
    case 'sql': return 'sql';
    case 'md': case 'markdown': case 'mdx': return 'markdown';
    case 'yml': case 'yaml': return 'yaml';
    case 'xml': case 'svg': case 'xsd': case 'xsl': case 'xslt': case 'csproj': case 'plist': return 'xml';
    case 'sh': case 'bash': case 'zsh': return 'shell';
    case 'ps1': case 'psm1': return 'powershell';
    case 'bat': case 'cmd': return 'batch';
    case 'toml': return 'toml';
    case 'ini': case 'cfg': case 'conf': case 'properties': return 'properties';
    case 'rb': return 'ruby';
    case 'lua': return 'lua';
    case 'swift': return 'swift';
    case 'pl': case 'pm': return 'perl';
    case 'diff': case 'patch': return 'diff';
    case 'dockerfile': return 'dockerfile';
    default: return 'plaintext';
  }
}

/** Language support for the editor, loaded on demand (each is a separate chunk). */
export async function loadLanguage(path: string): Promise<Extension | null> {
  const id = languageId(path);
  switch (id) {
    case 'typescript': case 'typescriptreact': case 'javascript': case 'javascriptreact': {
      const { javascript } = await import('@codemirror/lang-javascript');
      return javascript({ jsx: id.endsWith('react'), typescript: id.startsWith('typescript') });
    }
    case 'json': return (await import('@codemirror/lang-json')).json();
    case 'html': return (await import('@codemirror/lang-html')).html();
    case 'css': case 'scss': case 'less': return (await import('@codemirror/lang-css')).css();
    case 'php': return (await import('@codemirror/lang-php')).php();
    case 'python': return (await import('@codemirror/lang-python')).python();
    case 'go': return (await import('@codemirror/lang-go')).go();
    case 'rust': return (await import('@codemirror/lang-rust')).rust();
    case 'java': case 'kotlin': case 'csharp': return (await import('@codemirror/lang-java')).java();
    case 'c': case 'cpp': return (await import('@codemirror/lang-cpp')).cpp();
    case 'sql': return (await import('@codemirror/lang-sql')).sql();
    case 'markdown': return (await import('@codemirror/lang-markdown')).markdown();
    case 'yaml': return (await import('@codemirror/lang-yaml')).yaml();
    case 'xml': return (await import('@codemirror/lang-xml')).xml();
    case 'shell': return StreamLanguage.define((await import('@codemirror/legacy-modes/mode/shell')).shell);
    case 'powershell': return StreamLanguage.define((await import('@codemirror/legacy-modes/mode/powershell')).powerShell);
    case 'batch': return StreamLanguage.define((await import('@codemirror/legacy-modes/mode/shell')).shell);
    case 'toml': return StreamLanguage.define((await import('@codemirror/legacy-modes/mode/toml')).toml);
    case 'properties': return StreamLanguage.define((await import('@codemirror/legacy-modes/mode/properties')).properties);
    case 'ruby': return StreamLanguage.define((await import('@codemirror/legacy-modes/mode/ruby')).ruby);
    case 'lua': return StreamLanguage.define((await import('@codemirror/legacy-modes/mode/lua')).lua);
    case 'swift': return StreamLanguage.define((await import('@codemirror/legacy-modes/mode/swift')).swift);
    case 'perl': return StreamLanguage.define((await import('@codemirror/legacy-modes/mode/perl')).perl);
    case 'diff': return StreamLanguage.define((await import('@codemirror/legacy-modes/mode/diff')).diff);
    case 'dockerfile': return StreamLanguage.define((await import('@codemirror/legacy-modes/mode/dockerfile')).dockerFile);
    default: return null;
  }
}
