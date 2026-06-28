/**
 * =============================================================================
 * CLAUDE ARCHIVAL & CODE EXTRACTION SUITE — Export Utilities Module
 * =============================================================================
 *
 * This module provides stateless utility functions for:
 *
 * 1. Generating YAML-frontmatter-enhanced Markdown from parsed conversations
 * 2. Creating ZIP archives from extracted code blocks using JSZip
 * 3. Triggering downloads via Blob URLs and programmatic anchor clicks
 * 4. Filename sanitization and language-to-extension mapping
 *
 * This file is loaded before content_script.js and exposes the `ExportUtils`
 * global object for consumption by the content script.
 *
 * @author Senior Staff Front-End Architect
 * @version 1.0.0
 */

;(function ExportUtilsModuleIIFE(global) {
  'use strict';

  // =========================================================================
  // CONSTANTS
  // =========================================================================

  /**
   * Language identifier → file extension mapping.
   * Duplicated here (from content_script.js CONFIG) to keep this module
   * self-contained and independently testable.
   */
  const LANGUAGE_EXTENSION_MAP = Object.freeze({
    javascript: 'js',
    typescript: 'ts',
    python: 'py',
    ruby: 'rb',
    java: 'java',
    csharp: 'cs',
    'c#': 'cs',
    cpp: 'cpp',
    'c++': 'cpp',
    c: 'c',
    go: 'go',
    golang: 'go',
    rust: 'rs',
    swift: 'swift',
    kotlin: 'kt',
    scala: 'scala',
    php: 'php',
    perl: 'pl',
    lua: 'lua',
    r: 'r',
    sql: 'sql',
    html: 'html',
    css: 'css',
    scss: 'scss',
    sass: 'sass',
    less: 'less',
    xml: 'xml',
    json: 'json',
    yaml: 'yaml',
    yml: 'yml',
    toml: 'toml',
    ini: 'ini',
    markdown: 'md',
    bash: 'sh',
    shell: 'sh',
    sh: 'sh',
    zsh: 'sh',
    powershell: 'ps1',
    dockerfile: 'Dockerfile',
    docker: 'Dockerfile',
    makefile: 'Makefile',
    cmake: 'cmake',
    graphql: 'graphql',
    protobuf: 'proto',
    terraform: 'tf',
    hcl: 'tf',
    vue: 'vue',
    svelte: 'svelte',
    jsx: 'jsx',
    tsx: 'tsx',
    dart: 'dart',
    elixir: 'ex',
    erlang: 'erl',
    haskell: 'hs',
    clojure: 'clj',
    lisp: 'lisp',
    scheme: 'scm',
    ocaml: 'ml',
    fsharp: 'fs',
    'f#': 'fs',
    assembly: 'asm',
    asm: 'asm',
    nasm: 'asm',
    wasm: 'wat',
    zig: 'zig',
    nim: 'nim',
    v: 'v',
    vlang: 'v',
    solidity: 'sol',
    nginx: 'conf',
    apache: 'conf',
    text: 'txt',
    plaintext: 'txt',
    plain: 'txt',
  });

  /**
   * Default base filenames by language category.
   * Used when no filename is provided for a code block.
   */
  const DEFAULT_FILENAMES = Object.freeze({
    js: 'script',
    ts: 'module',
    py: 'main',
    rb: 'main',
    java: 'Main',
    cs: 'Program',
    cpp: 'main',
    c: 'main',
    go: 'main',
    rs: 'main',
    swift: 'main',
    kt: 'Main',
    scala: 'Main',
    php: 'index',
    html: 'index',
    css: 'styles',
    scss: 'styles',
    sass: 'styles',
    less: 'styles',
    json: 'data',
    xml: 'data',
    yaml: 'config',
    yml: 'config',
    toml: 'config',
    ini: 'config',
    sh: 'script',
    ps1: 'script',
    sql: 'query',
    md: 'document',
    vue: 'App',
    svelte: 'App',
    jsx: 'App',
    tsx: 'App',
    dart: 'main',
    ex: 'main',
    erl: 'main',
    hs: 'Main',
    clj: 'core',
    graphql: 'schema',
    proto: 'schema',
    tf: 'main',
    sol: 'Contract',
    Dockerfile: 'Dockerfile',
    Makefile: 'Makefile',
  });

  // =========================================================================
  // MODULE A: MARKDOWN ARCHIVER
  // =========================================================================

  /**
   * Generates a complete Markdown document from a parsed conversation,
   * including YAML frontmatter metadata for Obsidian compatibility.
   *
   * Output structure:
   * ```
   * ---
   * title: "Chat Title"
   * date_scraped: "2024-01-15T10:30:00.000Z"
   * source_url: "https://claude.ai/chat/..."
   * estimated_tokens: 1234
   * message_count: 10
   * tags:
   *   - claude
   *   - ai-conversation
   * ---
   *
   * # Chat Title
   *
   * ## User
   * prompt text...
   *
   * Assistant response text...
   *
   * ## User
   * next prompt...
   * ```
   *
   * @param {Array} messages - Parsed message array from ConversationParser
   * @param {Object} metadata - Conversation metadata
   * @returns {string} Complete Markdown document string
   */
  function generateMarkdown(messages, metadata) {
    const lines = [];

    // --- Calculate estimated token count ---
    const totalText = messages.map(m => m.content).join('');
    const estimatedTokens = Math.ceil(totalText.length / 4);

    // --- YAML Frontmatter ---
    lines.push('---');
    lines.push(`title: "${escapeYamlString(metadata.title)}"`);
    lines.push(`date_scraped: "${metadata.scrapedAt}"`);
    lines.push(`date_scraped_human: "${metadata.scrapedAtHuman}"`);
    lines.push(`source_url: "${metadata.url}"`);
    lines.push(`estimated_tokens: ${estimatedTokens}`);
    lines.push(`message_count: ${messages.length}`);
    lines.push(`human_messages: ${messages.filter(m => m.role === 'human').length}`);
    lines.push(`assistant_messages: ${messages.filter(m => m.role === 'assistant').length}`);

    // Count total code blocks
    const totalCodeBlocks = messages.reduce(
      (sum, m) => sum + m.codeBlocks.length + m.artifacts.length,
      0
    );
    lines.push(`code_blocks: ${totalCodeBlocks}`);

    // Detect languages used
    const languagesUsed = new Set();
    for (const msg of messages) {
      for (const block of msg.codeBlocks) {
        if (block.language) languagesUsed.add(block.language);
      }
      for (const artifact of msg.artifacts) {
        if (artifact.language) languagesUsed.add(artifact.language);
      }
    }
    if (languagesUsed.size > 0) {
      lines.push('languages:');
      for (const lang of Array.from(languagesUsed).sort()) {
        lines.push(`  - ${lang}`);
      }
    }

    lines.push('tags:');
    lines.push('  - claude');
    lines.push('  - ai-conversation');
    lines.push('  - auto-exported');
    lines.push('---');
    lines.push('');

    // --- Document Title ---
    lines.push(`# ${metadata.title}`);
    lines.push('');
    lines.push(`> Exported on ${metadata.scrapedAtHuman} | ~${estimatedTokens.toLocaleString()} tokens | [Source](${metadata.url})`);
    lines.push('');
    lines.push('---');
    lines.push('');

    // --- Message Bodies ---
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];

      if (msg.role === 'human') {
        // Human messages get H2 headers
        lines.push(`## 👤 User (Turn ${Math.floor(i / 2) + 1})`);
        lines.push('');
        lines.push(msg.content);
        lines.push('');
      } else {
        // Assistant messages are standard text
        lines.push(`### 🤖 Claude`);
        lines.push('');
        lines.push(msg.content);
        lines.push('');

        // If there are artifacts, add a summary section
        if (msg.artifacts.length > 0) {
          lines.push('#### Artifacts');
          lines.push('');
          for (const artifact of msg.artifacts) {
            lines.push(`**${artifact.title}** (${artifact.language || artifact.type || 'unknown'})`);
            lines.push('');
            const lang = artifact.language || '';
            lines.push(`\`\`\`${lang}`);
            lines.push(artifact.code.trimEnd());
            lines.push('```');
            lines.push('');
          }
        }
      }

      // Add separator between message pairs
      if (msg.role === 'assistant' && i < messages.length - 1) {
        lines.push('---');
        lines.push('');
      }
    }

    // --- Footer ---
    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push(`*Exported by Claude Archival & Code Extraction Suite v1.0.0*`);

    return lines.join('\n');
  }

  /**
   * Escapes special characters in a string for safe YAML embedding.
   *
   * @param {string} str - Raw string
   * @returns {string} Escaped string safe for YAML double-quoted values
   */
  function escapeYamlString(str) {
    if (!str) return '';
    return str
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t');
  }

  // =========================================================================
  // MODULE B: CODEBASE ZIP EXTRACTOR
  // =========================================================================

  /**
   * Generates a ZIP archive containing all extracted code blocks as
   * individual files with appropriate extensions and naming.
   *
   * File naming strategy:
   * 1. If the code block has an explicit fileName, use it
   * 2. Otherwise, use `{defaultName}.{extension}` based on the language
   * 3. If multiple files share the same name, append `_1`, `_2`, etc.
   *
   * Directory structure:
   * ```
   * {conversation_title}_codebase/
   * ├── README.md          (auto-generated manifest)
   * ├── script.js
   * ├── main.py
   * ├── main_1.py
   * ├── styles.css
   * └── index.html
   * ```
   *
   * @param {Array<{language: string, code: string, fileName: string|null}>} codeBlocks
   * @param {Object} metadata - Conversation metadata
   * @returns {Promise<Blob>} ZIP file as a Blob
   */
  async function generateZip(codeBlocks, metadata) {
    if (typeof JSZip === 'undefined') {
      throw new Error('JSZip library is not loaded. Cannot generate ZIP archive.');
    }

    const zip = new JSZip();
    const folderName = sanitizeFilename(metadata.title) + '_codebase';
    const folder = zip.folder(folderName);

    // Track filenames to handle duplicates
    const filenameCounts = new Map();

    // Process each code block
    const fileManifest = [];

    for (let i = 0; i < codeBlocks.length; i++) {
      const block = codeBlocks[i];
      const { language, code, fileName: explicitFileName } = block;

      let finalFilename;

      if (explicitFileName) {
        // Use the explicit filename, ensuring it has an extension
        finalFilename = sanitizeFilename(explicitFileName);
        if (!finalFilename.includes('.')) {
          const ext = resolveExtension(language);
          finalFilename += `.${ext}`;
        }
      } else {
        // Generate filename from language
        const ext = resolveExtension(language);
        const baseName = DEFAULT_FILENAMES[ext] || 'file';
        finalFilename = `${baseName}.${ext}`;
      }

      // Handle duplicate filenames
      if (filenameCounts.has(finalFilename)) {
        const count = filenameCounts.get(finalFilename) + 1;
        filenameCounts.set(finalFilename, count);

        // Insert counter before extension
        const lastDot = finalFilename.lastIndexOf('.');
        if (lastDot > 0) {
          finalFilename = `${finalFilename.substring(0, lastDot)}_${count}${finalFilename.substring(lastDot)}`;
        } else {
          finalFilename = `${finalFilename}_${count}`;
        }
      } else {
        filenameCounts.set(finalFilename, 0);
      }

      // Add file to ZIP
      folder.file(finalFilename, code);

      fileManifest.push({
        filename: finalFilename,
        language: language || 'unknown',
        sizeBytes: new Blob([code]).size,
        lineCount: code.split('\n').length,
      });
    }

    // --- Generate README.md manifest ---
    const readme = generateZipReadme(metadata, fileManifest);
    folder.file('README.md', readme);

    // Generate the ZIP blob
    const zipBlob = await zip.generateAsync({
      type: 'blob',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });

    return zipBlob;
  }

  /**
   * Generates a README.md manifest file for the ZIP archive.
   *
   * @param {Object} metadata - Conversation metadata
   * @param {Array} fileManifest - Array of file info objects
   * @returns {string} README content
   */
  function generateZipReadme(metadata, fileManifest) {
    const lines = [];

    lines.push(`# ${metadata.title} — Extracted Codebase`);
    lines.push('');
    lines.push(`> Auto-extracted from Claude.ai conversation`);
    lines.push(`> Source: ${metadata.url}`);
    lines.push(`> Extracted: ${metadata.scrapedAtHuman}`);
    lines.push('');
    lines.push('## Files');
    lines.push('');
    lines.push('| # | Filename | Language | Lines | Size |');
    lines.push('|---|----------|----------|-------|------|');

    for (let i = 0; i < fileManifest.length; i++) {
      const f = fileManifest[i];
      const sizeFormatted = f.sizeBytes > 1024
        ? `${(f.sizeBytes / 1024).toFixed(1)} KB`
        : `${f.sizeBytes} B`;
      lines.push(`| ${i + 1} | \`${f.filename}\` | ${f.language} | ${f.lineCount} | ${sizeFormatted} |`);
    }

    lines.push('');
    lines.push('---');
    lines.push('');
    lines.push('*Generated by Claude Archival & Code Extraction Suite v1.0.0*');

    return lines.join('\n');
  }

  /**
   * Resolves a file extension from a language identifier.
   *
   * @param {string} language - Language identifier (e.g., 'python', 'javascript')
   * @returns {string} File extension (e.g., 'py', 'js')
   */
  function resolveExtension(language) {
    if (!language) return 'txt';

    const normalized = language.toLowerCase().trim();

    // Direct lookup
    if (LANGUAGE_EXTENSION_MAP[normalized]) {
      return LANGUAGE_EXTENSION_MAP[normalized];
    }

    // Partial match (e.g., 'python3' → 'python')
    for (const [key, ext] of Object.entries(LANGUAGE_EXTENSION_MAP)) {
      if (normalized.startsWith(key) || key.startsWith(normalized)) {
        return ext;
      }
    }

    // If the language string itself looks like an extension (1-5 chars, alphanumeric)
    if (/^[a-z0-9]{1,5}$/.test(normalized)) {
      return normalized;
    }

    return 'txt';
  }

  // =========================================================================
  // SHARED UTILITIES
  // =========================================================================

  /**
   * Triggers a file download by creating a temporary anchor element
   * and clicking it programmatically.
   *
   * This approach works within the content script security context
   * and doesn't require any additional permissions.
   *
   * @param {Blob} blob - The file data as a Blob
   * @param {string} filename - Desired download filename
   */
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);

    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.style.display = 'none';

    // Append to the main document (not shadow DOM) for download to work
    document.body.appendChild(anchor);
    anchor.click();

    // Cleanup: revoke the object URL and remove the anchor after a delay
    // to ensure the download has started
    setTimeout(() => {
      URL.revokeObjectURL(url);
      if (anchor.parentNode) {
        anchor.parentNode.removeChild(anchor);
      }
    }, 5000);
  }

  /**
   * Sanitizes a string for use as a filename by removing or replacing
   * characters that are invalid in file systems.
   *
   * @param {string} name - Raw filename string
   * @returns {string} Sanitized filename
   */
  function sanitizeFilename(name) {
    if (!name) return 'untitled';

    return name
      // Replace path separators and other dangerous chars
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
      // Replace spaces and dots at start/end
      .replace(/^[\s.]+|[\s.]+$/g, '')
      // Replace consecutive spaces/underscores with single underscore
      .replace(/[\s]+/g, '_')
      // Limit length
      .substring(0, 100)
      // Final trim
      .trim() || 'untitled';
  }

  // =========================================================================
  // EXPORT PUBLIC API
  // =========================================================================

  /**
   * The ExportUtils global object exposes all export-related functions
   * for use by the content script.
   */
  global.ExportUtils = Object.freeze({
    generateMarkdown,
    generateZip,
    downloadBlob,
    sanitizeFilename,
    resolveExtension,
  });

})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this));
