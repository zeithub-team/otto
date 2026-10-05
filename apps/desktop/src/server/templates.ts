/**
 * Starter files for new projects: .gitignore templates and LICENSE texts.
 * Short licenses ship in full; the long ones (Apache, GPL, AGPL, MPL) are
 * fetched from the SPDX license list when online — never paraphrased.
 */

export interface GitignoreTemplate {
  id: string;
  label: string;
  content: string;
}

const IDE_OS = `# IDE and OS
.idea/
.vscode/*
!.vscode/extensions.json
*.swp
*.swo
.DS_Store
Thumbs.db
desktop.ini
`;

const ENV = `# Environment and secrets
.env
.env.*
!.env.example
`;

const NODE = `# Dependencies
node_modules/
.pnp
.pnp.js

# Build output
dist/
build/
out/
.next/
.nuxt/
.output/
.svelte-kit/
.turbo/
.parcel-cache/
.cache/

# Logs and coverage
*.log
npm-debug.log*
yarn-debug.log*
yarn-error.log*
pnpm-debug.log*
coverage/
.nyc_output/

# Misc
*.tsbuildinfo
.eslintcache
`;

const PYTHON = `# Byte-compiled and caches
__pycache__/
*.py[cod]
*$py.class
.pytest_cache/
.mypy_cache/
.ruff_cache/
.tox/
.nox/

# Virtual environments
.venv/
venv/
env/
ENV/

# Packaging and build
build/
dist/
*.egg-info/
.eggs/
wheels/
pip-wheel-metadata/

# Coverage and notebooks
.coverage
htmlcov/
.ipynb_checkpoints/
`;

const PHP = `# Composer
/vendor/
composer.phar

# Caches and logs
*.log
.phpunit.result.cache
.php-cs-fixer.cache
`;

const LARAVEL = `/vendor/
/node_modules/
/public/build
/public/hot
/public/storage
/storage/*.key
/storage/pail
/bootstrap/cache/*.php
.phpunit.result.cache
Homestead.json
Homestead.yaml
auth.json
npm-debug.log
yarn-error.log
`;

const JAVA = `# Compiled
*.class
*.jar
*.war
*.ear
hs_err_pid*

# Maven
target/
!.mvn/wrapper/maven-wrapper.jar

# Gradle
.gradle/
build/
!gradle/wrapper/gradle-wrapper.jar

# Logs
*.log
`;

const GO = `# Binaries
*.exe
*.exe~
*.dll
*.so
*.dylib
*.test
*.out
/bin/

# Go workspace and vendoring
go.work
/vendor/
`;

const RUST = `/target/
**/*.rs.bk
# Library crates keep Cargo.lock out of version control; applications should commit it.
# Cargo.lock
`;

const DOTNET = `# Build output
[Bb]in/
[Oo]bj/
[Dd]ebug/
[Rr]elease/
x64/
x86/

# Visual Studio
.vs/
*.user
*.suo
*.userosscache
*.sln.docstates

# NuGet
*.nupkg
packages/
project.lock.json

# Test results
TestResults/
*.trx
`;

const FLUTTER = `# Dart and Flutter
.dart_tool/
.packages
.pub-cache/
.pub/
build/
.flutter-plugins
.flutter-plugins-dependencies
pubspec.lock
*.g.dart
*.freezed.dart

# Platform
ios/Pods/
android/.gradle/
android/local.properties
`;

const RUBY = `*.gem
*.rbc
/.config
/coverage/
/tmp/
/log/*
!/log/.keep
/vendor/bundle
.bundle/
`;

/** Every template is completed with the same IDE/OS block; secrets go in for the web stacks. */
const compose = (body: string, withEnv = true): string => `${body.trimEnd()}\n\n${withEnv ? `${ENV}\n` : ''}${IDE_OS}`;

export const GITIGNORE_TEMPLATES: GitignoreTemplate[] = [
  { id: 'node', label: 'Node.js / JavaScript / TypeScript', content: compose(NODE) },
  { id: 'python', label: 'Python', content: compose(PYTHON) },
  { id: 'laravel', label: 'Laravel (PHP)', content: compose(LARAVEL) },
  { id: 'php', label: 'PHP (Composer)', content: compose(PHP) },
  { id: 'java', label: 'Java (Maven / Gradle)', content: compose(JAVA, false) },
  { id: 'go', label: 'Go', content: compose(GO, false) },
  { id: 'rust', label: 'Rust', content: compose(RUST, false) },
  { id: 'dotnet', label: '.NET / C#', content: compose(DOTNET, false) },
  { id: 'flutter', label: 'Flutter / Dart', content: compose(FLUTTER, false) },
  { id: 'ruby', label: 'Ruby / Rails', content: compose(RUBY) },
  { id: 'ide', label: 'IDE and OS files only', content: `${IDE_OS}` },
];

export interface LicenseInfo {
  id: string;
  label: string;
  /** The text carries a copyright line that needs the holder's name. */
  holder: boolean;
}

interface LicenseDef extends LicenseInfo {
  /** Full text with `{year}` / `{holder}` placeholders; absent → fetched from SPDX. */
  text?: string;
  spdx?: string;
}

const MIT = `MIT License

Copyright (c) {year} {holder}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

const BSD2 = `BSD 2-Clause License

Copyright (c) {year}, {holder}
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
`;

const BSD3 = `BSD 3-Clause License

Copyright (c) {year}, {holder}
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
`;

const ISC = `ISC License

Copyright (c) {year}, {holder}

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
PERFORMANCE OF THIS SOFTWARE.
`;

const UNLICENSE = `This is free and unencumbered software released into the public domain.

Anyone is free to copy, modify, publish, use, compile, sell, or
distribute this software, either in source code form or as a compiled
binary, for any purpose, commercial or non-commercial, and by any
means.

In jurisdictions that recognize copyright laws, the author or authors
of this software dedicate any and all copyright interest in the
software to the public domain. We make this dedication for the benefit
of the public at large and to the detriment of our heirs and
successors. We intend this dedication to be an overt act of
relinquishment in perpetuity of all present and future rights to this
software under copyright law.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS BE LIABLE FOR ANY CLAIM, DAMAGES OR
OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE,
ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
OTHER DEALINGS IN THE SOFTWARE.

For more information, please refer to <https://unlicense.org>
`;

const LICENSES: LicenseDef[] = [
  { id: 'mit', label: 'MIT', holder: true, text: MIT },
  { id: 'apache-2.0', label: 'Apache 2.0', holder: false, spdx: 'Apache-2.0' },
  { id: 'gpl-3.0', label: 'GNU GPL v3', holder: false, spdx: 'GPL-3.0-only' },
  { id: 'agpl-3.0', label: 'GNU AGPL v3', holder: false, spdx: 'AGPL-3.0-only' },
  { id: 'mpl-2.0', label: 'Mozilla MPL 2.0', holder: false, spdx: 'MPL-2.0' },
  { id: 'bsd-3-clause', label: 'BSD 3-Clause', holder: true, text: BSD3 },
  { id: 'bsd-2-clause', label: 'BSD 2-Clause', holder: true, text: BSD2 },
  { id: 'isc', label: 'ISC', holder: true, text: ISC },
  { id: 'unlicense', label: 'Unlicense (public domain)', holder: false, text: UNLICENSE },
];

export const licenseList = (): LicenseInfo[] => LICENSES.map(({ id, label, holder }) => ({ id, label, holder }));
export const gitignoreList = (): Array<{ id: string; label: string }> => GITIGNORE_TEMPLATES.map(({ id, label }) => ({ id, label }));
export const gitignoreContent = (id: string): string | null => GITIGNORE_TEMPLATES.find((t) => t.id === id)?.content ?? null;

export interface RenderedLicense {
  text: string;
  /** Set when the official text could not be downloaded and a stub was written instead. */
  warning?: string;
}

/** LICENSE file text for `id`; long licenses come from the SPDX list (needs internet). */
export async function renderLicense(id: string, holder: string, year = new Date().getFullYear()): Promise<RenderedLicense | null> {
  const def = LICENSES.find((l) => l.id === id);
  if (!def) return null;
  if (def.text) {
    return { text: def.text.replace('{year}', String(year)).replace('{holder}', holder.trim() || 'the copyright holders') };
  }
  const url = `https://raw.githubusercontent.com/spdx/license-list-data/main/text/${def.spdx}.txt`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(7000) });
    if (res.ok) {
      const text = (await res.text()).trim();
      if (text.length > 500) return { text: `${text}\n` };
    }
  } catch {
    /* offline — fall through to the stub */
  }
  return {
    text: `${def.label}\n\nThe full license text could not be downloaded. Replace this file with the official text:\nhttps://spdx.org/licenses/${def.spdx}.html\n`,
    warning: `${def.label}: the full text could not be downloaded (offline?) — LICENSE contains a link only`,
  };
}
