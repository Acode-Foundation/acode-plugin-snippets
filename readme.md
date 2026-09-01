# acode-plugin-snippets
![version](https://img.shields.io/badge/Latest%20version-V2.0.0-green)
> Snippets plugin for the Ace and CodeMirror editors in Acode. It provides code autocompletion for the languages listed below.

**NOTE:** This plugin is not fully supported in Acode version lower than v1.6.0 (212).
Please update your **Acode App** to latest version for using this plugin.

## Using snippets

A snippet turns a short trigger into a reusable code template. For example, in
a JavaScript file, type `fun` to use the function snippet.

The workflows below apply to CodeMirror. Ace continues using its native snippet
completion and expansion behavior.

### With autocomplete suggestions enabled

1. Start typing a snippet trigger.
2. Select the suggestion marked with the plugin logo and confirm it. You can
   also type the complete trigger and press <kbd>Tab</kbd> to expand it directly.

### With autocomplete suggestions disabled

Turning off **Autocomplete suggestions** hides plugin snippets from completion
menus, but it does not disable snippet expansion. Acode's built-in, word, or
language-server suggestions may still open while you type.

1. Type the complete snippet trigger.
2. If a completion menu is visible, press <kbd>Esc</kbd> once to close it.
3. Press <kbd>Tab</kbd> to expand the snippet. If no menu is visible, press
   <kbd>Tab</kbd> directly.

When a completion menu is visible, <kbd>Esc</kbd> dismisses it. Once a snippet
session is active, <kbd>Esc</kbd> ends that session.

### Moving through snippet fields

After expansion, the first editable field is selected. Press <kbd>Tab</kbd> to
move to the next field and <kbd>Shift</kbd>+<kbd>Tab</kbd> to move to the
previous one. Repeated fields and transformed values update as you edit.

### If a snippet does not expand

If a snippet does not expand, check that:

- The complete trigger is typed exactly, including any punctuation or case.
- The file has the correct language mode.
- The expected snippets directory is shown below **Set snippets directory**.
- A language mapping is configured when the mode and snippet filename differ.
- Any open completion menu has been dismissed with <kbd>Esc</kbd> before
  pressing <kbd>Tab</kbd>.

## Default snippets directory

On a fresh CodeMirror installation, the plugin creates
`/public/.acode-snippets` in Terminal Home and copies every bundled snippet
there. This makes the active snippets editable without choosing a directory
first. Enable hidden files in the file browser, or use `ls -a` in the terminal,
to see the directory.

Existing installations are not migrated, and existing files are never
overwritten. Ace installations continue to use the bundled snippets by
default. Resetting the snippets directory also returns to the bundled snippets.
The plugin settings show the active directory below **Set snippets directory**.

Uninstalling the plugin clears its remembered directory so a later reinstall
starts fresh. The editable `.acode-snippets` directory and its contents are
preserved.

## How to enable custom snippets?

- Open command palette
- Type `set snippets path`
- Create a new directory or select a directory with snippets in it.
- Navigate to the snippet directory, open and edit any snippets file

The selected directory is applied immediately. Existing Ace-format `.snippets` files remain compatible.

## How to disable custom snippets?

- Open command palette
- Type `reset snippets path`

The bundled snippets are restored immediately.

## Custom language mappings

CodeMirror users can open **Language mappings** in the plugin settings to map
an Acode language mode to an existing snippet file. For example, `zig → rust`
loads `rust.snippets` whenever a Zig file is active. The `.snippets` suffix is
optional when creating a mapping.

Mappings are only needed when the Acode mode and snippet filename differ, or
when one language should reuse another language's snippets. A `zig.snippets`
file already works with the `zig` mode without a mapping. Custom mappings take
priority over built-in aliases, and deleting a mapping restores the built-in
behavior.

Each snippets directory has its own mappings. Switching directories activates
the mappings previously saved for that directory. Ace continues using its
native mode and snippet resolution unchanged.

## CodeMirror support

Ace-format triggers, scopes, guards, tab stops, mirrors, choices, variables,
conditionals, and TextMate transforms work in CodeMirror. Follow the
**Using snippets** guide above for autocomplete, direct expansion, and field
navigation.

Snippet suggestions use the plugin logo in CodeMirror's completion menu, making
them easy to distinguish from other suggestions. The CodeMirror-only
**Autocomplete suggestions** setting controls whether snippets appear in that
menu; it does not disable trigger-plus-Tab expansion, placeholder choices, or
field navigation.

The plugin detects JavaScript and CSS regions embedded in HTML and PHP. Native
Ace builds continue to use Ace's own snippet engine and completion behavior.

## Editing snippet files

Files ending in `.snippets` are detected as the **Snippets** language in
CodeMirror. Comments, directives, regex guards, tab-indented bodies,
placeholders, choices, variables, and transforms receive syntax highlighting.
The plugin logo is also used as the file icon in tabs and the file browser.

Ace already includes its own native snippets language mode, which remains
unchanged.

## Supported languages in Snippet Plugin

- Abc
- ActionScript
- Blade
- C/C++
- Clojure
- Coffee
- CsoundSynthesizer
- CsoundOrchestra
- CSS
- Dart
- Diff
- Django
- Drools
- Edifacts
- Erlang
- Fsl
- Gobstones
- Golang
- Graphqlschema
- Haml
- Haskell
- HTML
- Java
- JavaScript
- Jsp
- Jsx
- Kotlin
- Liquid
- Lsl
- Lua
- Makefile
- Markdown
- Maze
- Perl
- Php
- Python
- R
- Razor
- Robot
- Rst
- Ruby
- Rust
- Sh
- Snippets
- SQL
- SQLServer
- Swift
- TCL
- Textile
- Tsx
- Twig
- Typescript
- Velocity
- Wallok

## Authors
- [@Ajit Kumar](https://github.com/deadlyjack)

## Development

Install dependencies with `npm ci`, then run `npm run lint` and `npm test` to
check the source and test suite. Use `npm run lint:fix` to apply safe Biome lint
fixes.

Run `npm run dev` (or the backward-compatible `npm run start-dev`) to watch the
bundle and serve the completed archive over local HTTP. The command prints the
LAN URL to use for `dist.zip` after the first successful build. The generated
`dist/` directory and `dist.zip` archive are local build outputs and are not
committed.

## How to write snippets?

Check out [this](https://cloud9-sdk.readme.io/docs/snippets) article on how to write snippets.

## Upcomming updates

- Create snippets for language that are not already available.

Thank you for using Acode and acode-plugin-snippets.
