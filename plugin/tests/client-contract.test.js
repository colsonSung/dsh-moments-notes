import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const clientPath = fileURLToPath(new URL('../client.js', import.meta.url));
const source = existsSync(clientPath) ? readFileSync(clientPath, 'utf8') : '';
const packageName = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')).name;
const escapedPackageName = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function includes(pattern, message) {
  assert.match(source, pattern, message);
}

test('client is a native module-loader bundle using only React.createElement', () => {
  includes(/window\.__ModuleLoader__\.load\s*\(\s*\{/, 'registers through the browser module loader');
  // The bundle id is the package name: a published copy may be renamed, and the
  // module the loader registers has to follow whatever the package is called.
  includes(new RegExp(`id\\s*:\\s*['\"]${escapedPackageName}['\"]`), 'uses the package module id');
  includes(/factory\s*\(\s*require\s*\)/, 'uses the loader factory');
  includes(/require\(\s*['"]react['"]\s*\)/, 'loads React from Harness');
  includes(/React\.createElement/, 'uses React.createElement');
  // Anchored at a line start: the guard is about module statements, and a
  // sentence in a comment that happens to start a word with "import" is not one.
  assert.doesNotMatch(source, /^[ \t]*(?:import|export)\s+(?:default\s+)?(?:[\w*{]|React\b)/m, 'must not contain module imports/exports');
  assert.doesNotMatch(source, /require\(\s*['"](?!react['"])/, 'must not import external Harness UI components');
});

test('registers the Moments sidebar panel and main page', () => {
  includes(/ctx\.slots\.inject\(\s*['"]sidebar\.panellist['"]/, 'injects the sidebar slot');
  includes(/name\s*:\s*['"]sidebar\.panellist['"][\s\S]{0,240}id\s*:\s*['"]moments-notes['"]/, 'uses the required panel id');
  includes(/ctx\.slots\.inject\(\s*['"]main['"]/, 'injects the main slot');
  includes(/name\s*:\s*['"]main['"][\s\S]{0,180}key\s*:\s*['"]moments-notes['"]/, 'uses the required main key');
  includes(/ctx\.effect\s*\(/, 'registrations participate in plugin disposal');
});

test('uses the Moments name everywhere without legacy branding', () => {
  includes(/Moments/, 'shows the new Chinese brand');
  includes(/moments-notes:recent-searches:v1/, 'namespaces recent searches for Moments');
  includes(/# Moments notes export/, 'names Markdown exports for Moments');
  includes(/label:\s*\(\)\s*=>\s*['"]Moments['"]/, 'labels the native panel');
  assert.doesNotMatch(source, /flomo|浮墨/i, 'removes legacy package, text and storage branding');
});

test('presents a standard Harness title and toolbar instead of a brand hero', () => {
  includes(/className:\s*['"]mm-titlebar['"]/, 'has a standard titlebar');
  includes(/className:\s*['"]mm-title['"]\s*\}\s*,\s*['"]Moments['"]\)/, 'uses a simple native title');
  includes(/className:\s*['"]mm-toolbar['"]/, 'groups search and actions in a toolbar');
  assert.doesNotMatch(source, /mm-brand-mark|mm-review-hero|linear-gradient\(125deg/, 'no independent brand mark, hero or green gradient');
});

test('implements the JSON host transport and envelope error handling', () => {
  includes(/const\s+API_ENDPOINT\s*=\s*['"]\/api\/moments-notes['"]/, 'uses the Host endpoint');
  includes(/fetch\(\s*API_ENDPOINT\s*,\s*\{/, 'uses browser fetch');
  includes(/method\s*:\s*['"]POST['"]/, 'uses POST');
  includes(/['"]Content-Type['"]\s*:\s*['"]application\/json['"]/, 'sends JSON');
  includes(/JSON\.stringify\(\s*\{\s*method\s*,\s*payload\s*\}/, 'sends method and payload');
  includes(/body\.ok|data\.ok/, 'checks the response envelope');
  includes(/body\.result|data\.result/, 'unwraps result');
  includes(/error\?\.code|error\.code/, 'preserves Host error codes');
});

test('calls every Host method with the required payload shape', () => {
  for (const method of ['snapshot', 'create', 'update', 'pin', 'trash', 'restore', 'purge', 'related', 'review', 'export', 'import']) {
    includes(new RegExp(`api\\(\\s*['"]${method}['"]`), `calls ${method}`);
  }
  includes(/api\(\s*['"]create['"]\s*,\s*\{\s*content\s*,\s*attachments\s*\}/, 'create payload');
  includes(/api\(\s*['"]update['"]\s*,\s*\{\s*id\s*:\s*editingId\s*,\s*content\s*,\s*attachments\s*\}/, 'update payload');
  includes(/api\(\s*['"]pin['"]\s*,\s*\{\s*id\s*,\s*pinned\s*\}/, 'pin payload');
  includes(/api\(\s*['"]related['"]\s*,\s*\{\s*id\s*,\s*limit\s*\}/, 'related payload');
  includes(/api\(\s*['"]review['"]\s*,\s*\{\s*mode\s*\}/, 'review payload');
  includes(/api\(\s*['"]import['"]\s*,\s*\{\s*data\s*,\s*mode\s*\}/, 'import payload');
});

test('editor supports create, edit, tag autocomplete and image previews', () => {
  includes(/function\s+Editor\b/, 'has an editor component');
  includes(/editingId/, 'supports editing existing notes');
  includes(/tagQuery|tagSuggestions/, 'computes tag suggestions');
  includes(/getCaretTag|activeTagMatch/, 'detects the tag at the caret');
  includes(/readAsDataURL/, 'reads local images');
  includes(/accept\s*:\s*['"]image\/\*['"]|accept\s*=\s*['"]image\/\*['"]/, 'restricts picker to images');
  includes(/attachments\.map\s*\(/, 'renders attachment previews');
  includes(/Remove image/, 'can remove image previews');
  includes(/'Save note'|'Save changes'/, 'has a real save action');
});

test('composer follows the reference layout with a bordered card and compact icon tools', () => {
  includes(/mm-editor-icon-button/, 'renders compact icon buttons');
  includes(/aria-label['"]:\s*['"]Add image['"]/, 'has an image button');
  includes(/aria-label['"]:\s*['"]Insert tag['"]/, 'has a tag button');
  includes(/aria-label['"]:\s*['"]Text format['"]/, 'has a text-format button');
  includes(/aria-label['"]:\s*['"]Bullet list['"]/, 'has a bullet button');
  includes(/aria-label['"]:\s*['"]Numbered list['"]/, 'has an ordered button');
  includes(/mm-editor-count/, 'shows a character count');
  includes(/aria-label['"]:\s*['"]Save note['"]/, 'saves from an icon button');
  includes(/name:\s*['"]send['"]/, 'uses a send icon');
  includes(/\.mm-editor-input\{[^}]*border:0/, 'the textarea carries no inner border');
  includes(/\.mm-editor\{[^}]*border-radius:var\(--dsw-radius-md\)/, 'uses a rounded surface');
  includes(/mm-format-toolbar[\s\S]{0,400}formatRowVisible|showFormats/, 'shows the format row on demand');
});

test('the input surfaces stay clean with a single subtle frame and no inner rules', () => {
  includes(/\.mm-editor\{[^}]*border:1px solid var\(--mm-line\)/, 'the composer keeps one subtle border');
  assert.doesNotMatch(source, /\.mm-editor-footer\{[^}]*border-top/, 'no divider line inside the composer');
  assert.doesNotMatch(source, /\.mm-inline-actions\{[^}]*border-top/, 'no divider line inside the inline editor');
  assert.doesNotMatch(source, /\.mm-inline-editor\{[^}]*border:1px/, 'the inline editor adds no extra frame');
  assert.doesNotMatch(source, /\.mm-inline-editor:focus-within\{[^}]*box-shadow/, 'the inline editor adds no inner ring');
});

test('text inputs never receive the heavy global focus ring', () => {
  assert.doesNotMatch(source, /button:focus-visible[^{]*textarea:focus-visible/, 'the global focus ring excludes textareas');
  includes(/\.mm-editor-input:focus-visible\{outline:0/, 'the composer textarea keeps no outline');
  includes(/\.mm-inline-editor-input:focus-visible\{outline:0/, 'the inline textarea keeps no outline');
});

test('the panel opens the desktop float through the Host', () => {
  includes(/Open the desktop float/, 'has a desktop float action');
  includes(/api\(\s*['"]float-open['"]/, 'asks the Host to start the desktop window');
  includes(/api\(\s*['"]float-close['"]/, 'can close the desktop window');
  assert.doesNotMatch(source, /window\.open\(/, 'never relies on a browser popup');
});

test('the in-page float stays as the fallback and offers the desktop window', () => {
  includes(/shell\.overlay/, 'registers the float in the frame-wide overlay layer');
  includes(/mm-float/, 'has its own float surface');
  includes(/floatBus/, 'shares open state with the float');
  includes(/'Pin'|'Unpin'/, 'offers the note pin control');
  includes(/openDesktopFloat/, 'opens the desktop window from the float');
  assert.doesNotMatch(source, /window\.open\(/, 'never relies on a browser popup');
});

test('the float drags from where it is grabbed', () => {
  includes(/getBoundingClientRect\(\)/, 'measures the float before dragging');
  includes(/event\.clientX\s*-\s*drag\.offsetX/, 'drags relative to the grab point');
  includes(/event\.clientY\s*-\s*drag\.offsetY/, 'drags vertically relative to the grab point');
});

test('the float no longer fakes an always-on-top pin', () => {
  assert.doesNotMatch(source, /FLOAT_PINNED_KEY/, 'drops the in-page pin state');
  assert.doesNotMatch(source, /mm-float\.is-pinned/, 'drops the pin styling');
  assert.doesNotMatch(source, /mm-float\.is-pinned/, 'the float carries no pin styling');
});

test('the float positions itself with a transform, independent of the overlay container', () => {
  includes(/translate3d\(/, 'moves the float with a transform offset');
  assert.doesNotMatch(source, /left:\s*`\$\{position\.left\}px`/, 'never positions with left/top inside the overlay');
  assert.doesNotMatch(source, /left:\s*`\$\{position\.left\}px`/, 'does not re-anchor on layout changes');
  includes(/function\s+clampFloatPosition[\s\S]{0,900}getBoundingClientRect/, 'clamps against the live viewport rect');
});

test('the float keeps a viewport-anchored position across panel switches', () => {
  includes(/FLOAT_VIEWPORT_KEY/, 'stores the position in viewport coordinates');
  includes(/writeStoredValue\(FLOAT_VIEWPORT_KEY/, 'persists the viewport position');
  includes(/readStoredValue\(FLOAT_VIEWPORT_KEY/, 'restores the viewport position');
  includes(/FLOAT_VIEWPORT_KEY[\s\S]{0,400}getBoundingClientRect/, 're-anchors from the live viewport rect');
  assert.doesNotMatch(source, /left:\s*`\$\{position\.left\}px`/, 'never positions with left/top inside the overlay');
});

test('the float stays inside the safe area and never covers the window controls', () => {
  includes(/FLOAT_SAFE_INSET/, 'declares a safe-area inset');
  includes(/FLOAT_MIN_TOP/, 'keeps the float below the title bar');
  includes(/clampFloatPosition/, 'clamps the float position');
  includes(/function\s+clampFloatPosition[\s\S]{0,600}FLOAT_MIN_TOP/, 'applies the minimum top when clamping');
  assert.doesNotMatch(source, /function\s+clampFloatPosition[\s\S]{0,600}left:\s*0\b/, 'never parks the float at the left edge');
});

test('editor save control is disabled whenever the global save guard is busy', () => {
  includes(/h\(Editor,\s*\{[\s\S]{0,600}busy:\s*Boolean\(busy\)/, 'matches the global busy guard');
});

test('client attachment count, total size and MIME limits match the Host', () => {
  includes(/MAX_ATTACHMENTS\s*=\s*8/, 'allows the same eight attachments as the Host');
  includes(/MAX_TOTAL_IMAGE_SIZE\s*=\s*10\s*\*\s*1024\s*\*\s*1024/, 'enforces the Host total byte limit before saving');
  includes(/image\/png/, 'allows PNG');
  includes(/image\/jpeg/, 'allows JPEG');
  includes(/image\/webp/, 'allows WebP');
  includes(/image\/gif/, 'allows GIF');
  assert.doesNotMatch(source, /slice\(0,\s*12\)|最多保留\s*12\s*张/, 'does not promise twelve attachments');
});

test('timeline text is formatted as safe React nodes without HTML injection', () => {
  includes(/function\s+SafeText\b/, 'has a safe text renderer');
  includes(/content\.split|text\.split/, 'renders note text as explicit lines');
  assert.doesNotMatch(source, /dangerouslySetInnerHTML|\.innerHTML\s*=|document\.write\s*\(/, 'never injects note HTML');
});

test('safe text supports tags, emphasis, code and safe links', () => {
  includes(/\*\*|\\\*\\\*/, 'supports emphasis markers');
  includes(/`[^`]+`|\\`/, 'supports inline code markers');
  includes(/https\?:|https\\?/, 'recognizes HTTP links');
  includes(/href\s*:/, 'renders links as React elements');
  includes(/rel\s*:\s*['"]noreferrer noopener['"]/, 'protects opened links');
  includes(/onTag/, 'makes rendered tags interactive');
  assert.doesNotMatch(source, /dangerouslySetInnerHTML|\.innerHTML\s*=|document\.write\s*\(/, 'never injects note HTML');
});

test('search, recent searches and timeline filters are implemented', () => {
  includes(/function\s+SearchBar\b/, 'has a search component');
  includes(/recentSearches/, 'tracks recent searches');
  includes(/localStorage/, 'persists recent searches locally');
  includes(/activeTag/, 'filters by tag');
  includes(/dateFilter/, 'filters by date');
  includes(/activeView/, 'filters timeline views');
  includes(/Clear filters/, 'can clear filters');
});

test('tag hierarchy, counts, statistics and heatmap are real components', () => {
  includes(/function\s+TagTree\b/, 'has a hierarchical tag tree');
  includes(/buildTagTree|createTagTree/, 'builds tag hierarchy');
  includes(/function\s+Heatmap\b/, 'has a heatmap');
  includes(/function\s+StatsPanel\b/, 'has a statistics panel');
  includes(/Day streak|Days recorded|Total notes|notes/, 'shows the note statistics');
  includes(/heatmap|heat-cell/, 'styles heatmap cells');
});

test('all note actions call real behavior including related notes', () => {
  for (const label of ['Edit', 'Copy', 'Pin', 'Delete', 'Restore', 'Delete permanently', 'Related notes']) {
    assert.ok(source.includes(label), `contains action ${label}`);
  }
  includes(/navigator\.clipboard|clipboard\.writeText/, 'copies with the browser clipboard');
  includes(/function\s+RelatedDialog\b/, 'has a related-notes dialog');
  includes(/relatedLoading|loadingRelated/, 'handles related-note loading');
});

test('trash requires confirmation, supports restore and explains thirty-day retention', () => {
  includes(/action\s*===\s*['"]trash['"][\s\S]{0,600}setConfirmState/, 'asks before moving a note to trash');
  includes(/trash-confirmed/, 'only calls the Host after confirmation');
  includes(/30\s*days/, 'explains the thirty-day retention window');
  includes(/'Restore'/, 'keeps restore available');
});

test('notes open an inline editor in place on double click', () => {
  includes(/onDoubleClick:\s*\(\)\s*=>\s*onEdit\(note\)/, 'enters edit mode on double click');
  includes(/function\s+InlineEditor\b/, 'renders an inline editor component');
  includes(/mm-inline-editor/, 'has an inline editor surface');
  includes(/setInlineEditingId\(note\.id\)/, 'opens that note in place');
  includes(/Double-click to edit/, 'hints the double-click interaction');
});

test('editor offers paragraph formatting shortcuts and a format toolbar', () => {
  includes(/function\s+applyFormat\b/, 'has a shared format applier');
  includes(/SHORTCUT_FORMATS/, 'maps shortcut keys to formats');
  includes(/'b':\s*'bold'/, 'maps b to bold');
  includes(/'i':\s*'italic'/, 'maps i to italic');
  includes(/'e':\s*'code'/, 'maps e to inline code');
  includes(/'k':\s*'link'/, 'maps k to link');
  includes(/event\.key\s*===\s*'7'/, 'has an ordered list shortcut');
  includes(/event\.key\s*===\s*'8'/, 'has a bullet list shortcut');
  includes(/className:\s*['"]mm-format-toolbar['"]/, 'renders a formatting toolbar');
  includes(/'Bold'/, 'labels the bold action');
  includes(/'Italic'/, 'labels the italic action');
  includes(/'Strikethrough'/, 'labels the strikethrough action');
  includes(/'Bullet list'/, 'labels the bullet list action');
  includes(/'Numbered list'/, 'labels the ordered list action');
});

test('editors accept pasted screenshots as note attachments', () => {
  includes(/onPaste/, 'handles paste on the textarea');
  includes(/clipboardData/, 'reads images from the clipboard');
  includes(/getAsFile\(\)/, 'extracts clipboard image files');
  includes(/kind\s*===\s*['"]file['"]/, 'only reads file items');
  includes(/readClipboardAttachments/, 'uses one clipboard reader');
  includes(/handlePaste[\s\S]{0,600}preventDefault\(\)/, 'prevents the default paste for images');
  includes(/onPaste:\s*\(event\)\s*=>\s*void\s+handlePaste\(event\)/, 'wires the paste handler into the textarea');
  includes(/mm-inline-attachments/, 'shows pasted images inside the inline editor');
  includes(/function\s+InlineEditor[\s\S]{0,900}setAttachments/, 'tracks attachments while editing in place');
  includes(/saveInlineEdit[\s\S]{0,400}attachments/, 'persists pasted attachments with the inline save');
  includes(/onSave:\s*\(content,\s*attachments\)\s*=>\s*onSaveInline\(note,\s*content,\s*attachments\)/, 'binds the note id into the inline save');
});

test('safe text renders the supported paragraph formats', () => {
  includes(/~~/, 'supports the strikethrough marker');
  includes(/is-ordered/, 'renders ordered list items');
  includes(/mm-heading/, 'renders headings');
  includes(/mm-quote/, 'renders quotes');
  includes(/mm-strike/, 'renders strikethrough');
});

test('long notes can expand and collapse', () => {
  includes(/expandedNotes|expandedIds/, 'tracks expanded notes');
  includes(/'Expand'|'Collapse'/, 'has expand and collapse labels');
  includes(/LONG_NOTE|longNote|isLong/, 'detects long notes');
});

test('timeline uses an editorial date column with aligned note cards', () => {
  includes(/\.mm-timeline\{display:flex;flex-direction:column;gap:32px\}/, 'uses consistent day-group spacing');
  includes(/\.mm-day-group\{position:relative;display:grid;grid-template-columns:88px minmax\(0,1fr\);gap:16px;align-items:start\}/, 'gives each date its own scanning column');
  includes(/\.mm-day-group:before\{display:none\}/, 'removes the misaligned vertical rail');
  includes(/\.mm-day-marker\{position:sticky;top:16px;display:flex;flex-direction:column;align-items:flex-start;gap:4px;padding:12px 0 0 16px;border-left:1px solid var\(--mm-line\);text-align:left\}/, 'keeps the date visible beside its notes');
  includes(/\.mm-day-notes\{position:relative;display:flex;flex-direction:column;gap:12px\}/, 'uses consistent card spacing');
  includes(/\.mm-day-notes:before\{display:none\}/, 'removes the overlapping rail dot');
  includes(/\.mm-note-card\{position:relative;padding:20px/, 'uses one generous card padding value');
});

test('random and on-this-day reviews call the Host and render results', () => {
  includes(/function\s+ReviewPanel\b/, 'has a review component');
  includes(/random/, 'supports random review');
  includes(/on-this-day/, 'supports on-this-day review');
  includes(/'Random review'|'On this day'/, 'has the review controls');
  includes(/reviewLoading|loadingReview/, 'handles review loading');
});

test('JSON import/export and Markdown export use local downloads', () => {
  includes(/function\s+downloadFile|const\s+downloadFile/, 'has a download helper');
  includes(/URL\.createObjectURL/, 'downloads with object URLs');
  includes(/application\/json/, 'exports JSON');
  includes(/text\/markdown/, 'exports Markdown');
  includes(/toMarkdown|notesToMarkdown/, 'serializes Markdown');
  includes(/JSON\.parse/, 'parses imports');
  includes(/merge|replace/, 'supports both import modes');
  includes(/'Merge import'|'Replace import'/, 'offers the import modes');
});

test('the inline editor uses the same reference styling as the top composer', () => {
  includes(/mm-inline-count/, 'shows a character count inline');
  includes(/mm-inline-send/, 'saves with an inline send button');
  includes(/\.mm-inline-editor-input\{[^}]*border:0/, 'the inline textarea carries no inner border');
  includes(/\.mm-inline-editor\{[^}]*border:0/, 'the inline editor adds no frame');
  includes(/\.mm-inline-editor\{[^}]*background:transparent/, 'the inline editor stays transparent');
  includes(/\.mm-note-card\.is-editing\{[^}]*--mm-accent/, 'the edited card is marked by one accent');
  includes(/mm-inline-toolbar[\s\S]{0,300}mm-format-button/, 'uses the compact format buttons');
});

test('array backups are normalized to the versioned Host import contract', () => {
  includes(/setImportData\(Array\.isArray\(data\)\s*\?\s*\{\s*version:\s*1,\s*notes:\s*data\s*\}\s*:\s*data\)/, 'wraps legacy arrays');
});

test('client tag extraction and selection normalize case like the Host', () => {
  includes(/function\s+extractTags[\s\S]{0,700}toLocaleLowerCase/, 'normalizes extracted tag case');
  includes(/function\s+normalizeTagName[\s\S]{0,250}toLocaleLowerCase/, 'normalizes selected tag case');
  includes(/const\s+tag\s*=\s*normalizeTagName\(match\[1\]\)/, 'uses one canonical tag normalizer');
  includes(/split\(['"]\/['"]\)[\s\S]{0,120}filter[\s\S]{0,120}join\(['"]\/['"]\)/, 'collapses duplicate separators');
  includes(/tag\s*&&\s*tag\.length\s*<=\s*200/, 'skips overlong text tags like the Host');
  assert.ok(source.includes("const pattern = /#([\\p{L}\\p{N}_-][\\p{L}\\p{N}_/-]*)/gu;"), 'accepts leading-hyphen tags like the Host');
});

test('editing opens the note in place instead of jumping to the top composer', () => {
  includes(/const\s+startEdit[\s\S]{0,300}setInlineEditingId\(note\.id\)/, 'opens inline editing for the note');
  includes(/onSaveInline/, 'saves the inline edit');
  includes(/onCancelInline/, 'cancels the inline edit');
  includes(/mm-inline-toolbar/, 'shows a formatting toolbar inside the inline editor');
});

test('review cards synchronize pin, trash and purge changes from the global snapshot', () => {
  includes(/function\s+ReviewPanel\(\{\s*noteProps,\s*onError,\s*notes\s*\}/, 'receives global notes');
  includes(/setReviewNotes\(\(current\)[\s\S]{0,500}notes\.find/, 'maps review cards to latest notes');
  includes(/filter\(Boolean\)[\s\S]{0,200}deletedAt|filter\(\(note\)\s*=>\s*note\s*&&\s*!note\.deletedAt\)/, 'removes deleted and purged review cards');
  includes(/h\(ReviewPanel,\s*\{\s*noteProps,\s*onError:\s*showError,\s*notes\s*\}/, 'passes the global snapshot');
});

test('editor automatically grows with its content up to the bounded height', () => {
  includes(/scrollHeight/, 'measures content height');
  includes(/style\.height\s*=\s*['"]auto['"]/, 'resets before measuring');
  includes(/Math\.min\([^)]*scrollHeight[^)]*420/, 'caps automatic growth at 420px');
});

test('keyboard shortcuts, dialogs and async states are accessible', () => {
  includes(/metaKey|ctrlKey/, 'supports Command or Control shortcuts');
  includes(/Escape/, 'supports Escape');
  includes(/role\s*:\s*['"]dialog['"]|role=\{['"]dialog['"]\}/, 'has an accessible dialog');
  includes(/aria-modal/, 'marks modal dialogs');
  includes(/aria-label/, 'labels icon controls');
  includes(/role\s*:\s*['"]alert['"]|role=\{['"]alert['"]\}/, 'announces errors');
  includes(/Loading notes/, 'has loading state');
  includes(/No notes yet|No notes match|still no notes/, 'has empty states');
  includes(/function\s+ConfirmDialog\b/, 'confirms destructive actions');
});

test('snapshot distinguishes permission and partial failures with recovery actions', () => {
  includes(/Permission required/, 'explains an unauthorized session');
  includes(/failure\.code[^\n]*HTTP_401|HTTP_401[^\n]*failure\.code|failure\.code[^\n]*HTTP_403|HTTP_403[^\n]*failure\.code/, 'uses the Host status to identify permission failures');
  includes(/partialWarning/, 'tracks notes that could not be rendered separately from total failure');
  includes(/Retry failed items/, 'offers a concrete partial-failure recovery action');
  includes(/filter\(\(note\)\s*=>\s*note\s*&&\s*typeof note\.id\s*===\s*['"]string['"]\s*&&\s*note\.id\)/, 'keeps readable notes when a snapshot contains invalid rows');
});

test('uses one native note column with lightweight navigation and dialog-only statistics', () => {
  includes(/\.mm-app\{[^}]*background:var\(--mm-surface-0\)/, 'roots the workspace in the canvas surface');
  // The sidebar width is a variable so it can fold to a rail; the layout is
  // still exactly two columns, with 200px as the open width.
  includes(/\.mm-shell\{[^}]*grid-template-columns:var\(--mm-side-width,200px\) minmax\(0,1fr\)/, 'uses exactly two workspace columns');
  includes(/\.mm-shell\.is-collapsed\{[^}]*--mm-side-width:56px/, 'folds the sidebar to a rail');
  // The rail keeps every way in: the navigation must not be swallowed by the
  // expanded branch.
  includes(/\.mm-left\.is-collapsed \.mm-nav button\{[^}]*justify-content:center/, 'the rail centres its icons');
  includes(/\.mm-left\.is-collapsed \.mm-nav button span,[\s\S]{0,120}display:none/, 'the rail hides the words, not the buttons');
  assert.ok(
    (source.match(/className: 'mm-nav'/g) || []).length === 1,
    'there is one navigation list, rendered in both states',
  );
  includes(/\.mm-left\{[^}]*var\(--dsw-specific-sidebar-fill\)/, 'uses the native sidebar fill');
  includes(/statsOpen\s*\?\s*h\(DialogShell[\s\S]{0,220}statsPanel\)/, 'keeps statistics in a dialog');
  assert.equal((source.match(/\bstatsPanel\b/g) || []).length, 2, 'creates stats only for the dialog');
  assert.doesNotMatch(source, /mm-right|grid-template-columns:\d+px minmax\(0,1fr\) \d+px/, 'removes the persistent third column');
  assert.doesNotMatch(source, /\bfm-/, 'removes the legacy visual system');
});

test('uses readable native body and metadata typography', () => {
  includes(/\.mm-app\{[^}]*font-size:14px/, 'uses a readable native body size');
  assert.doesNotMatch(source, /font-size:(?:[1-9]|10)px\b/, 'does not shrink metadata below 11px');
});

test('styling is responsive, reduced-motion aware and based on theme tokens', () => {
  includes(/@media\s*\(max-width:/, 'has responsive breakpoints');
  includes(/prefers-reduced-motion/, 'respects reduced motion');
  includes(/--mm-surface-1/, 'uses the plugin surface ramp');
  includes(/--dsw-alias-label-primary/, 'uses text theme tokens');
  includes(/--mm-line-strong/, 'uses the plugin border tokens');
  assert.doesNotMatch(source, /#[0-9a-fA-F]{3,8}\b/, 'does not hard-code hex colors');
});

test('the dark theme gives floating overlays their own dark tint', () => {
  // The host's overlay token is a mid grey in the dark theme: every floating
  // control (the AI field, menus, hints) rendered as a grey chip until the
  // dark block defined its own.
  const darkStart = source.indexOf('body[data-ds-dark-theme] .mm-app');
  assert.ok(darkStart > -1, 'the dark theme block exists');
  const darkEnd = source.indexOf('}', source.indexOf('--mm-overview-sticky', darkStart));
  const darkBlock = source.slice(darkStart, darkEnd);
  assert.match(darkBlock, /--mm-overlay:color-mix\(/, 'the dark block tints its own overlay');
  assert.doesNotMatch(darkBlock, /--mm-overlay:var\(--dsw-alias-bg-overlay\)/, 'never inherits the grey host overlay');
});

test('the warm editorial system keeps accent, metadata and elevation disciplined', () => {
  includes(/--mm-accent-base:rgb\(181 64 42\)/, 'uses the contrast-checked light seal');
  includes(/--mm-accent-base:rgb\(228 100 74\)/, 'uses the contrast-checked dark seal');
  includes(/\.mm-titlebar\{[^}]*display:grid/, 'compacts title, search and actions into one grid');
  includes(/\.mm-title-row\{display:contents\}/, 'lets the title row participate in that grid');
  includes(/\.mm-note-card\{[^}]*box-shadow:none/, 'keeps reading cards flat and quiet');
  includes(/\.mm-toast\{position:absolute;left:224px;right:auto;/, 'anchors notifications inside the main content instead of the viewport or float');
  assert.doesNotMatch(source, /\.mm-note-actions\{[^}]*opacity:/, 'does not fade persistent note actions');
  assert.doesNotMatch(source, /color:var\(--dsw-alias-label-tertiary\)/, 'does not use low-contrast tertiary text');
  assert.doesNotMatch(source, /--dsw-alias-brand-primary/, 'does not mistake the achromatic host brand for an accent');
});

test('styling uses only theme tokens exposed by the installed Harness', () => {
  const allowed = new Set([
    'bg-base', 'bg-layer-1', 'bg-layer-2', 'bg-overlay', 'border-l1', 'border-l2',
    'brand-primary', 'label-primary', 'label-secondary', 'label-tertiary',
    'interactive-bg-hover', 'state-business-primary', 'state-error-primary',
    'state-idle-primary', 'state-success-primary', 'state-warn-primary',
  ]);
  const used = [...source.matchAll(/--dsw-alias-([a-z0-9-]+)/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(used.filter((token) => !allowed.has(token)))], []);
});

test('does not embed frames, remote dependencies or fake controls', () => {
  assert.doesNotMatch(source, /<iframe|h\(\s*['"]iframe['"]|React\.createElement\(\s*['"]iframe['"]/, 'no iframe');
  assert.doesNotMatch(source, /https?:\/\/(?:cdn|unpkg|esm\.sh|jsdelivr)/i, 'no external cloud dependencies');
  assert.doesNotMatch(source, /onClick\s*:\s*\(\s*\)\s*=>\s*\{\s*\}/, 'no empty click handlers');
  assert.doesNotMatch(source, /document\.body|document\.documentElement/, 'does not write DOM outside the plugin component');
  includes(/disabled\s*:/, 'uses real disabled states');
});

test('the canvas answers an agent asking for a picture, wherever the person is', () => {
  // The responder runs with the plugin rather than with the Design panel: an
  // agent asks while the person is in the conversation view.
  includes(/function startSnapshotResponder\(\)/, 'installs a snapshot responder');
  includes(/api\(\s*'snapshot-wait'/, 'parks a request for the Host');
  includes(/api\(\s*'snapshot-put'/, 'sends the picture back');
  includes(/api\(\s*'canvas-load'/, 'reads the saved board instead of the mounted one');
  includes(/startSnapshotResponder\(\), 'moments-notes: canvas snapshots'/, 'starts and stops with the plugin');
  includes(/Math\.min\(wanted,\s*cap \/ width\)/, 'caps the raster instead of trusting the board size');
});

test('the board menu offers the last Figma import report', () => {
  includes(/api\(\s*'canvas-import-report'/, 'reads the stored report');
  includes(/Last import report/, 'names the entry for a person');
  includes(/mm-canvas-report/, 'renders it in a panel, not a toast');
  includes(/not imported from a Figma file/, 'says plainly when there is no report');
  includes(/skippedSamples/, 'shows which nodes did not come through');
});

test('the panel offers a quick capture button in the Harness chrome', () => {
  includes(/name:\s*'conversation\.session\.header\.utilities'/, 'joins the conversation header utilities');
  includes(/name:\s*'sidebar\.right\.tab\.document\.actions'/, 'joins the document preview toolbar');
  includes(/id:\s*'moments-quick-note'/, 'registers one quick capture button');
  includes(/api\(\s*'float-status'/, 'asks the Host whether the float is open');
  includes(/api\(\s*'float-open'/, 'opens the desktop float');
  includes(/api\(\s*'float-close'/, 'closes the desktop float again');
});
