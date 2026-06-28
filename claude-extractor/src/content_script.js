/**
 * =============================================================================
 * CLAUDE ARCHIVAL & CODE EXTRACTION SUITE — Content Script
 * =============================================================================
 *
 * This is the main entry point injected into claude.ai pages. It handles:
 *
 * 1. SPA route-change detection via MutationObserver and URL polling
 * 2. Shadow DOM encapsulated UI injection (closed mode)
 * 3. DOM parser engine for extracting conversation data
 * 4. Coordination between the parser and export utility modules
 *
 * Design Principles:
 * - Zero CSS leakage via closed Shadow DOM
 * - Resilient to Anthropic's obfuscated/hashed class names
 * - Relies on semantic HTML structure, ARIA roles, data attributes, and
 *   DOM hierarchy rather than brittle class selectors
 * - Graceful degradation with comprehensive error boundaries
 *
 * @author Senior Staff Front-End Architect
 * @version 1.0.0
 */

;(function ClaudeExtractorSuiteIIFE() {
  'use strict';

  // =========================================================================
  // SECTION 1: CONSTANTS & CONFIGURATION
  // =========================================================================

  /**
   * Configuration object centralizing all tunable parameters.
   * Modify these selectors when Anthropic updates their DOM structure.
   */
  const CONFIG = Object.freeze({
    /** Unique identifier to prevent duplicate UI injection */
    INJECTED_MARKER: 'claude-extractor-suite-injected',

    /** Debounce delay in milliseconds for export button clicks */
    DEBOUNCE_MS: 1500,

    /** Polling interval for SPA route change detection (ms) */
    ROUTE_POLL_INTERVAL_MS: 800,

    /** Maximum retries for finding the chat container after navigation */
    MAX_MOUNT_RETRIES: 25,

    /** Delay between mount retries (ms) */
    MOUNT_RETRY_DELAY_MS: 400,

    /**
     * DOM SELECTION STRATEGIES
     * -------------------------------------------------------------------------
     * Anthropic uses hashed/obfuscated Tailwind-like classes that change between
     * deploys. We therefore use a layered strategy:
     *
     * Priority 1: ARIA roles and labels (most stable)
     * Priority 2: data-* attributes (moderately stable)
     * Priority 3: Semantic HTML structure and tag hierarchy
     * Priority 4: Positional selectors as last resort
     *
     * Each selector group has multiple fallback candidates.
     */
    SELECTORS: {
      /**
       * The main scrollable conversation container.
       * Strategies:
       * - Look for the element with role="presentation" or role="log"
       * - Look for a container with data-testid patterns
       * - Fallback: the largest scrollable div inside main
       */
      CHAT_CONTAINER_CANDIDATES: [
        '[data-testid="chat-messages"]',
        '[role="log"]',
        '[role="presentation"]',
        'main [class*="react-scroll"]',
        'main',
      ],

      /**
       * Individual message wrappers (both human and assistant).
       * We identify message blocks by their structural pattern:
       * - They are direct children or near-children of the chat container
       * - They contain distinct sub-elements for the sender icon and content
       * - Human messages often have a user avatar; assistant messages have the
       *   Claude icon
       */
      MESSAGE_BLOCK_CANDIDATES: [
        '[data-testid*="message"]',
        '[data-test*="message"]',
        '[class*="message"]',
      ],

      /**
       * Anthropic Artifact nodes — special rendered components for code,
       * documents, etc. These are distinct from inline code blocks.
       */
      ARTIFACT_CANDIDATES: [
        '[data-testid*="artifact"]',
        '[class*="artifact"]',
        '[data-artifact]',
      ],

      /**
       * Code block selectors within messages
       */
      CODE_BLOCK_SELECTOR: 'pre code, pre > code, [class*="code-block"] code',

      /**
       * The chat title, extracted from the page
       */
      TITLE_CANDIDATES: [
        'title',
        'h1',
        '[data-testid="chat-title"]',
        'header h1',
        'nav [class*="title"]',
      ],
    },

    /** File extension mapping from language identifiers to extensions */
    LANGUAGE_EXTENSION_MAP: Object.freeze({
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
    }),
  });

  // =========================================================================
  // SECTION 2: UTILITY FUNCTIONS
  // =========================================================================

  /**
   * Creates a debounced version of a function that delays invocation until
   * after `delay` milliseconds have elapsed since the last call.
   *
   * @param {Function} fn - The function to debounce
   * @param {number} delay - Delay in milliseconds
   * @returns {Function} Debounced function
   */
  function debounce(fn, delay) {
    let timeoutId = null;
    let isProcessing = false;

    return async function debouncedFn(...args) {
      if (isProcessing) {
        console.log('[Claude Extractor] Export already in progress, ignoring click.');
        return;
      }

      clearTimeout(timeoutId);
      timeoutId = setTimeout(async () => {
        isProcessing = true;
        try {
          await fn.apply(this, args);
        } catch (error) {
          console.error('[Claude Extractor] Export failed:', error);
        } finally {
          isProcessing = false;
        }
      }, delay);
    };
  }

  /**
   * Safely queries the DOM with multiple candidate selectors, returning
   * the first match found. Provides resilience against selector breakage.
   *
   * @param {string[]} candidates - Array of CSS selectors to try
   * @param {Element|Document} context - DOM context to query within
   * @returns {Element|null} First matching element or null
   */
  function querySelectorWithFallback(candidates, context = document) {
    for (const selector of candidates) {
      try {
        const element = context.querySelector(selector);
        if (element) return element;
      } catch (selectorError) {
        // Invalid selector syntax — skip silently
        console.debug(`[Claude Extractor] Selector "${selector}" invalid, skipping.`);
      }
    }
    return null;
  }

  /**
   * Queries all matching elements across multiple candidate selectors.
   *
   * @param {string[]} candidates - Array of CSS selectors to try
   * @param {Element|Document} context - DOM context to query within
   * @returns {Element[]} Array of matching elements (deduplicated)
   */
  function querySelectorAllWithFallback(candidates, context = document) {
    const resultSet = new Set();
    for (const selector of candidates) {
      try {
        const elements = context.querySelectorAll(selector);
        elements.forEach(el => resultSet.add(el));
      } catch (selectorError) {
        console.debug(`[Claude Extractor] Selector "${selector}" invalid, skipping.`);
      }
    }
    return Array.from(resultSet);
  }

  /**
   * Waits for an element matching any of the candidate selectors to appear
   * in the DOM, with configurable retries.
   *
   * @param {string[]} candidates - CSS selectors to poll for
   * @param {number} maxRetries - Maximum number of polling attempts
   * @param {number} delayMs - Delay between retries
   * @returns {Promise<Element|null>} Resolving element or null on timeout
   */
  async function waitForElement(candidates, maxRetries = CONFIG.MAX_MOUNT_RETRIES, delayMs = CONFIG.MOUNT_RETRY_DELAY_MS) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const element = querySelectorWithFallback(candidates);
      if (element) return element;
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
    console.warn('[Claude Extractor] Element not found after maximum retries:', candidates);
    return null;
  }

  // =========================================================================
  // SECTION 3: DOM PARSER ENGINE
  // =========================================================================

  /**
   * The ConversationParser is the core engine that traverses claude.ai's
   * chat DOM and produces a structured representation of the conversation.
   *
   * It handles:
   * - Delineation between Human and Assistant messages
   * - Rich text extraction (bold, italic, lists, tables, links)
   * - Code block extraction with language identification
   * - Artifact node detection and extraction
   *
   * Output Format:
   * ```
   * [
   *   {
   *     role: 'human' | 'assistant',
   *     content: 'Markdown-formatted text content',
   *     codeBlocks: [
   *       { language: 'python', code: '...', fileName: null }
   *     ],
   *     artifacts: [
   *       { title: '...', language: 'javascript', code: '...' }
   *     ]
   *   },
   *   ...
   * ]
   * ```
   */
  const ConversationParser = {

    /**
     * Main entry point: parses the entire visible conversation.
     *
     * @returns {{ messages: Array, metadata: Object }} Parsed conversation
     */
    parse() {
      console.log('[Claude Extractor] Starting conversation parse...');

      const metadata = this._extractMetadata();
      const messages = this._extractMessages();

      console.log(`[Claude Extractor] Parsed ${messages.length} messages with metadata:`, metadata);

      return { messages, metadata };
    },

    /**
     * Extracts conversation metadata from the page.
     *
     * @returns {Object} Metadata including title, date, URL
     * @private
     */
    _extractMetadata() {
      let title = 'Untitled Claude Conversation';

      // Strategy 1: Try to get from document title and clean it
      const pageTitle = document.title || '';
      if (pageTitle && !pageTitle.toLowerCase().includes('claude') || pageTitle.length > 10) {
        // Claude.ai typically shows "Chat Title - Claude" or similar
        title = pageTitle.replace(/\s*[-–—|]\s*Claude.*$/i, '').trim() || title;
      }

      // Strategy 2: Look for a visible title element in the header/nav
      if (title === 'Untitled Claude Conversation') {
        const titleCandidates = [
          'header button[class*="truncate"]',
          'nav button[class*="truncate"]',
          '[data-testid="chat-title"]',
          'header h1',
          'header span',
        ];
        const titleEl = querySelectorWithFallback(titleCandidates);
        if (titleEl && titleEl.textContent.trim()) {
          title = titleEl.textContent.trim();
        }
      }

      return {
        title,
        url: window.location.href,
        scrapedAt: new Date().toISOString(),
        scrapedAtHuman: new Date().toLocaleString(),
      };
    },

    /**
     * Identifies and extracts all message blocks from the chat container.
     *
     * STRATEGY:
     * Since Anthropic obfuscates class names, we use a hierarchical approach:
     *
     * 1. Find the main conversation container
     * 2. Identify message groups by looking for repeating sibling structures
     *    that contain both an avatar/icon region and a content region
     * 3. Determine role (human/assistant) by inspecting avatar content,
     *    data attributes, or structural position (human messages alternate
     *    with assistant messages starting from index 0)
     *
     * @returns {Array} Array of parsed message objects
     * @private
     */
    _extractMessages() {
      const messages = [];

      try {
        // --- Approach 1: Look for elements with clear role indicators ---
        const messageBlocks = this._findMessageBlocks();

        if (messageBlocks.length === 0) {
          console.warn('[Claude Extractor] No message blocks found. The DOM structure may have changed.');
          return messages;
        }

        for (const block of messageBlocks) {
          try {
            const role = this._determineMessageRole(block);
            const content = this._extractMessageContent(block);
            const codeBlocks = this._extractCodeBlocks(block);
            const artifacts = this._extractArtifacts(block);

            messages.push({
              role,
              content,
              codeBlocks,
              artifacts,
            });
          } catch (messageError) {
            console.error('[Claude Extractor] Error parsing individual message block:', messageError);
            // Continue to next message rather than failing entirely
          }
        }
      } catch (parseError) {
        console.error('[Claude Extractor] Critical error during message extraction:', parseError);
      }

      return messages;
    },

    /**
     * Locates all message block elements in the conversation.
     *
     * Uses multiple strategies with fallback logic:
     * 1. data-testid attributes
     * 2. Structural analysis of the conversation container
     * 3. ARIA-based detection
     *
     * @returns {Element[]} Array of message block DOM elements
     * @private
     */
    _findMessageBlocks() {
      // Strategy 1: Direct data-testid or role-based selectors
      let blocks = querySelectorAllWithFallback(CONFIG.SELECTORS.MESSAGE_BLOCK_CANDIDATES);
      if (blocks.length > 0) {
        console.log(`[Claude Extractor] Found ${blocks.length} message blocks via primary selectors.`);
        return blocks;
      }

      // Strategy 2: Anthropic renders messages as direct children of the
      // scrollable conversation container. Each message group is typically
      // a div containing the avatar + content. We look for the repeating
      // pattern of "groups of sibling divs" inside the chat container.
      console.log('[Claude Extractor] Primary selectors failed. Using structural analysis...');

      const chatContainer = this._findChatContainer();
      if (!chatContainer) {
        console.warn('[Claude Extractor] Cannot find chat container for structural analysis.');
        return [];
      }

      // Claude.ai typically renders each message turn as a direct child div
      // of the conversation container, or wrapped one level deep.
      // Each turn contains identifiable sub-structures.
      blocks = this._structuralMessageDetection(chatContainer);

      console.log(`[Claude Extractor] Structural analysis found ${blocks.length} message blocks.`);
      return blocks;
    },

    /**
     * Finds the main chat/conversation container element.
     *
     * @returns {Element|null}
     * @private
     */
    _findChatContainer() {
      // Try explicit selectors first
      let container = querySelectorWithFallback(CONFIG.SELECTORS.CHAT_CONTAINER_CANDIDATES);
      if (container) return container;

      // Fallback: find the largest scrollable container within <main>
      const main = document.querySelector('main');
      if (main) {
        const scrollables = Array.from(main.querySelectorAll('div')).filter(div => {
          const style = window.getComputedStyle(div);
          return (
            (style.overflowY === 'auto' || style.overflowY === 'scroll') &&
            div.scrollHeight > div.clientHeight
          );
        });

        if (scrollables.length > 0) {
          // Return the deepest scrollable container (most specific)
          return scrollables[scrollables.length - 1];
        }

        return main;
      }

      return null;
    },

    /**
     * Performs structural detection of message blocks by analyzing the DOM
     * tree pattern. Claude.ai renders messages in a predictable hierarchy
     * even though class names are obfuscated.
     *
     * The typical pattern as of 2024:
     * <div class="..."> <!-- conversation container -->
     *   <div class="..."> <!-- message group (human) -->
     *     <div class="..."> <!-- inner wrapper with avatar + content -->
     *       <div class="...">👤 avatar</div>
     *       <div class="...">message content with <p>, <pre>, etc.</div>
     *     </div>
     *   </div>
     *   <div class="..."> <!-- message group (assistant) -->
     *     <div class="...">
     *       <div class="...">🤖 avatar</div>
     *       <div class="...">response content</div>
     *     </div>
     *   </div>
     * </div>
     *
     * We identify message groups by looking for top-level children of the
     * chat container that contain rich text content (paragraphs, code blocks,
     * lists, etc.)
     *
     * @param {Element} container - The chat container element
     * @returns {Element[]} Detected message block elements
     * @private
     */
    _structuralMessageDetection(container) {
      const candidates = [];
      const children = Array.from(container.children);

      for (const child of children) {
        // A message block should contain meaningful text content
        // and typically has paragraph tags, code blocks, or list items
        const hasRichContent = child.querySelector('p, pre, ul, ol, table, h1, h2, h3, h4, h5, h6, blockquote');
        const hasSubstantialText = (child.textContent || '').trim().length > 2;

        if (hasRichContent || hasSubstantialText) {
          candidates.push(child);
        }
      }

      // If we found very few candidates, the messages might be nested one level deeper
      if (candidates.length <= 1 && children.length > 0) {
        for (const child of children) {
          const nestedChildren = Array.from(child.children);
          for (const nested of nestedChildren) {
            const hasRichContent = nested.querySelector('p, pre, ul, ol, table');
            const hasSubstantialText = (nested.textContent || '').trim().length > 2;
            if (hasRichContent || hasSubstantialText) {
              candidates.push(nested);
            }
          }
        }
      }

      return candidates;
    },

    /**
     * Determines whether a message block is from the human or assistant.
     *
     * Strategies (in priority order):
     * 1. data-testid or data-role attributes
     * 2. ARIA labels on the message or its ancestors
     * 3. Presence of a "human" avatar vs "Claude" icon
     * 4. CSS class heuristics (e.g., classes containing "human" or "user")
     * 5. Structural position (odd/even alternation)
     *
     * @param {Element} block - The message block element
     * @returns {'human'|'assistant'} The determined role
     * @private
     */
    _determineMessageRole(block) {
      // Strategy 1: Explicit data attributes
      const testId = block.getAttribute('data-testid') || '';
      const dataRole = block.getAttribute('data-role') || '';

      if (/human|user/i.test(testId) || /human|user/i.test(dataRole)) return 'human';
      if (/assistant|claude|ai|bot/i.test(testId) || /assistant|claude|ai|bot/i.test(dataRole)) return 'assistant';

      // Strategy 2: Check within the block for role indicators in nested attributes
      const allElements = block.querySelectorAll('[data-testid], [data-role], [aria-label]');
      for (const el of allElements) {
        const attrs = [
          el.getAttribute('data-testid'),
          el.getAttribute('data-role'),
          el.getAttribute('aria-label'),
        ].filter(Boolean).join(' ');

        if (/human|user/i.test(attrs)) return 'human';
        if (/assistant|claude|ai|bot/i.test(attrs)) return 'assistant';
      }

      // Strategy 3: Look for the Claude logo SVG or human avatar
      // Claude's icon typically has specific SVG paths or an img with alt text
      const hasClaude = block.querySelector(
        'svg[class*="claude"], img[alt*="Claude"], [class*="assistant"], [class*="claude"]'
      );
      if (hasClaude) return 'assistant';

      const hasHumanAvatar = block.querySelector(
        'img[alt*="User"], img[alt*="Avatar"], [class*="user"], [class*="human"]'
      );
      if (hasHumanAvatar) return 'human';

      // Strategy 4: Class name heuristics on the block itself and parents
      const classChain = this._getClassChain(block);
      if (/human|user/i.test(classChain)) return 'human';
      if (/assistant|claude|bot/i.test(classChain)) return 'assistant';

      // Strategy 5: Text content heuristic - check for "You" or "Claude" labels
      const firstText = (block.querySelector('p, span, div')?.textContent || '').trim().substring(0, 50);
      // Some versions of the UI have visible "You" / "Claude" labels

      // Strategy 6: Default based on the message's index in the conversation
      // Human messages typically start at index 0 and alternate
      const parent = block.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(
          c => c.querySelector('p, pre, ul, ol, table') || (c.textContent || '').trim().length > 2
        );
        const index = siblings.indexOf(block);
        return index % 2 === 0 ? 'human' : 'assistant';
      }

      return 'human'; // Fallback default
    },

    /**
     * Collects class names from an element and its ancestors (up to 3 levels).
     *
     * @param {Element} el - Target element
     * @returns {string} Space-separated class names
     * @private
     */
    _getClassChain(el) {
      const classes = [];
      let current = el;
      let depth = 0;
      while (current && depth < 4) {
        if (current.className && typeof current.className === 'string') {
          classes.push(current.className);
        }
        current = current.parentElement;
        depth++;
      }
      return classes.join(' ');
    },

    /**
     * Extracts the text content of a message block, converting DOM nodes
     * to Markdown-formatted text while preserving structure.
     *
     * This method walks the DOM tree recursively, translating HTML elements
     * to their Markdown equivalents.
     *
     * @param {Element} block - The message block element
     * @returns {string} Markdown-formatted content
     * @private
     */
    _extractMessageContent(block) {
      // Find the content area (excluding avatars, action buttons, etc.)
      // The content is typically in the largest child div or a div containing
      // paragraph/formatting tags
      const contentArea = this._findContentArea(block);
      if (!contentArea) {
        return block.textContent?.trim() || '';
      }

      return this._domToMarkdown(contentArea);
    },

    /**
     * Locates the actual content area within a message block,
     * excluding UI chrome like avatars, copy buttons, etc.
     *
     * @param {Element} block - The message block
     * @returns {Element|null} The content sub-element
     * @private
     */
    _findContentArea(block) {
      // Look for a div that contains the rich text content
      // Typically this is the div with the most <p> and text content

      // First check for explicit content containers
      const explicitContent = block.querySelector(
        '[data-testid*="content"], [class*="content"], [class*="message-body"]'
      );
      if (explicitContent) return explicitContent;

      // Find the deepest div that directly contains paragraph/rich elements
      const richContainers = Array.from(block.querySelectorAll('div')).filter(div => {
        const directRich = Array.from(div.children).filter(
          c => ['P', 'PRE', 'UL', 'OL', 'TABLE', 'BLOCKQUOTE', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6'].includes(c.tagName)
        );
        return directRich.length > 0;
      });

      if (richContainers.length > 0) {
        // Return the one with the most rich children (most likely the content area)
        return richContainers.reduce((best, current) => {
          const bestCount = best.querySelectorAll('p, pre, ul, ol, table').length;
          const currentCount = current.querySelectorAll('p, pre, ul, ol, table').length;
          return currentCount >= bestCount ? current : best;
        });
      }

      return block;
    },

    /**
     * Recursively converts a DOM subtree to Markdown text.
     *
     * Handles:
     * - Paragraphs → double newline separated text
     * - Bold (<strong>, <b>) → **text**
     * - Italic (<em>, <i>) → *text*
     * - Inline code (<code> not inside <pre>) → `text`
     * - Code blocks (<pre><code>) → ```language\ncode\n```
     * - Unordered lists → - item
     * - Ordered lists → 1. item
     * - Tables → Markdown pipe tables
     * - Links → [text](url)
     * - Headings → # text
     * - Blockquotes → > text
     * - Horizontal rules → ---
     * - Line breaks → \n
     *
     * @param {Element} element - Root element to convert
     * @returns {string} Markdown string
     * @private
     */
    _domToMarkdown(element) {
      const parts = [];

      for (const node of element.childNodes) {
        try {
          const md = this._nodeToMarkdown(node);
          if (md !== null && md !== undefined) {
            parts.push(md);
          }
        } catch (nodeError) {
          console.debug('[Claude Extractor] Error processing node:', nodeError);
          // Fallback: grab text content
          if (node.textContent) parts.push(node.textContent);
        }
      }

      return parts.join('').replace(/\n{3,}/g, '\n\n').trim();
    },

    /**
     * Converts a single DOM node to its Markdown representation.
     *
     * @param {Node} node - DOM node to convert
     * @returns {string|null} Markdown string
     * @private
     */
    _nodeToMarkdown(node) {
      // Text node
      if (node.nodeType === Node.TEXT_NODE) {
        return node.textContent;
      }

      // Not an element node
      if (node.nodeType !== Node.ELEMENT_NODE) {
        return '';
      }

      const tag = node.tagName.toUpperCase();
      const childMd = () => this._domToMarkdown(node);

      switch (tag) {
        case 'P':
          return `\n\n${childMd()}\n\n`;

        case 'BR':
          return '\n';

        case 'HR':
          return '\n\n---\n\n';

        case 'STRONG':
        case 'B':
          return `**${childMd()}**`;

        case 'EM':
        case 'I':
          return `*${childMd()}*`;

        case 'U':
          return `<u>${childMd()}</u>`;

        case 'S':
        case 'DEL':
        case 'STRIKE':
          return `~~${childMd()}~~`;

        case 'SUP':
          return `<sup>${childMd()}</sup>`;

        case 'SUB':
          return `<sub>${childMd()}</sub>`;

        case 'CODE': {
          // Only inline code — code inside <pre> is handled by the PRE case
          if (node.parentElement?.tagName === 'PRE') {
            return node.textContent || '';
          }
          const codeText = node.textContent || '';
          // Use double backticks if the code contains single backticks
          if (codeText.includes('`')) {
            return `\`\` ${codeText} \`\``;
          }
          return `\`${codeText}\``;
        }

        case 'PRE': {
          const codeEl = node.querySelector('code');
          const codeText = codeEl ? codeEl.textContent : node.textContent;
          const language = this._detectLanguageFromElement(codeEl || node);
          return `\n\n\`\`\`${language}\n${(codeText || '').trimEnd()}\n\`\`\`\n\n`;
        }

        case 'A': {
          const href = node.getAttribute('href') || '';
          const text = childMd();
          return href ? `[${text}](${href})` : text;
        }

        case 'IMG': {
          const alt = node.getAttribute('alt') || 'image';
          const src = node.getAttribute('src') || '';
          return `![${alt}](${src})`;
        }

        case 'H1':
          return `\n\n# ${childMd()}\n\n`;
        case 'H2':
          return `\n\n## ${childMd()}\n\n`;
        case 'H3':
          return `\n\n### ${childMd()}\n\n`;
        case 'H4':
          return `\n\n#### ${childMd()}\n\n`;
        case 'H5':
          return `\n\n##### ${childMd()}\n\n`;
        case 'H6':
          return `\n\n###### ${childMd()}\n\n`;

        case 'BLOCKQUOTE':
          return `\n\n${childMd().split('\n').map(line => `> ${line}`).join('\n')}\n\n`;

        case 'UL':
          return `\n\n${this._convertList(node, false)}\n\n`;

        case 'OL':
          return `\n\n${this._convertList(node, true)}\n\n`;

        case 'LI': {
          // LI is handled by _convertList, but if encountered standalone:
          return childMd();
        }

        case 'TABLE':
          return `\n\n${this._convertTable(node)}\n\n`;

        case 'THEAD':
        case 'TBODY':
        case 'TFOOT':
        case 'TR':
        case 'TH':
        case 'TD':
          // These are handled by _convertTable; if encountered standalone, recurse
          return childMd();

        case 'DIV':
        case 'SPAN':
        case 'SECTION':
        case 'ARTICLE':
        case 'ASIDE':
        case 'HEADER':
        case 'FOOTER':
        case 'MAIN':
        case 'NAV':
        case 'FIGURE':
        case 'FIGCAPTION':
        case 'DETAILS':
        case 'SUMMARY':
          // Generic containers — recurse into children
          return childMd();

        case 'BUTTON':
        case 'SVG':
        case 'PATH':
        case 'CIRCLE':
        case 'RECT':
        case 'LINE':
        case 'POLYGON':
        case 'POLYLINE':
        case 'ELLIPSE':
        case 'G':
        case 'DEFS':
        case 'USE':
        case 'SYMBOL':
        case 'CLIPPATH':
        case 'MASK':
        case 'PATTERN':
        case 'LINEARGRADIENT':
        case 'RADIALGRADIENT':
        case 'STOP':
        case 'FILTER':
        case 'FECOLORMATRIX':
        case 'FEBLEND':
        case 'STYLE':
        case 'SCRIPT':
        case 'NOSCRIPT':
        case 'IFRAME':
        case 'INPUT':
        case 'TEXTAREA':
        case 'SELECT':
        case 'OPTION':
        case 'FORM':
        case 'LABEL':
          // Skip interactive/non-content elements
          return '';

        default:
          // Unknown element — attempt to recurse
          return childMd();
      }
    },

    /**
     * Converts a UL or OL element to Markdown list syntax, supporting
     * nested lists up to arbitrary depth.
     *
     * @param {Element} listElement - UL or OL element
     * @param {boolean} ordered - Whether this is an ordered list
     * @param {number} depth - Current nesting depth
     * @returns {string} Markdown list string
     * @private
     */
    _convertList(listElement, ordered, depth = 0) {
      const items = [];
      const indent = '  '.repeat(depth);
      let counter = 1;

      for (const child of listElement.children) {
        if (child.tagName !== 'LI') continue;

        // Separate direct text/inline content from nested lists
        let itemText = '';
        let nestedLists = '';

        for (const liChild of child.childNodes) {
          if (liChild.nodeType === Node.ELEMENT_NODE &&
              (liChild.tagName === 'UL' || liChild.tagName === 'OL')) {
            const isNested = liChild.tagName === 'OL';
            nestedLists += '\n' + this._convertList(liChild, isNested, depth + 1);
          } else if (liChild.nodeType === Node.ELEMENT_NODE) {
            itemText += this._nodeToMarkdown(liChild) || '';
          } else if (liChild.nodeType === Node.TEXT_NODE) {
            itemText += liChild.textContent || '';
          }
        }

        itemText = itemText.trim();
        const prefix = ordered ? `${counter}. ` : '- ';
        items.push(`${indent}${prefix}${itemText}${nestedLists}`);
        counter++;
      }

      return items.join('\n');
    },

    /**
     * Converts an HTML table to Markdown pipe table format.
     *
     * @param {Element} tableElement - TABLE element
     * @returns {string} Markdown table string
     * @private
     */
    _convertTable(tableElement) {
      const rows = tableElement.querySelectorAll('tr');
      if (rows.length === 0) return '';

      const markdownRows = [];
      let isFirstRow = true;

      for (const row of rows) {
        const cells = row.querySelectorAll('th, td');
        const cellTexts = Array.from(cells).map(cell => {
          return this._domToMarkdown(cell).replace(/\|/g, '\\|').replace(/\n/g, ' ').trim();
        });

        markdownRows.push(`| ${cellTexts.join(' | ')} |`);

        // Add separator after header row
        if (isFirstRow) {
          const separator = cellTexts.map(() => '---').join(' | ');
          markdownRows.push(`| ${separator} |`);
          isFirstRow = false;
        }
      }

      return markdownRows.join('\n');
    },

    /**
     * Detects the programming language from a code element's class name
     * or other attributes.
     *
     * @param {Element} element - The code or pre element
     * @returns {string} Language identifier (empty string if unknown)
     * @private
     */
    _detectLanguageFromElement(element) {
      if (!element) return '';

      // Check class names for language- or lang- prefixes
      const classes = (element.className || '').toString();
      const langMatch = classes.match(/(?:language|lang|hljs)-(\w[\w+#-]*)/i);
      if (langMatch) return langMatch[1].toLowerCase();

      // Check data attributes
      const dataLang = element.getAttribute('data-language') ||
                       element.getAttribute('data-lang') ||
                       element.getAttribute('data-code-language');
      if (dataLang) return dataLang.toLowerCase();

      // Check parent pre element
      const pre = element.closest('pre');
      if (pre && pre !== element) {
        const preClasses = (pre.className || '').toString();
        const preLangMatch = preClasses.match(/(?:language|lang|hljs)-(\w[\w+#-]*)/i);
        if (preLangMatch) return preLangMatch[1].toLowerCase();

        const preDataLang = pre.getAttribute('data-language') ||
                           pre.getAttribute('data-lang') ||
                           pre.getAttribute('data-code-language');
        if (preDataLang) return preDataLang.toLowerCase();
      }

      // Check sibling or parent elements for language labels
      // (Anthropic sometimes renders a language label above the code block)
      const parentContainer = pre?.parentElement || element.parentElement;
      if (parentContainer) {
        const labelEl = parentContainer.querySelector(
          '[class*="lang"], [class*="language"], span[class*="code-header"], div[class*="code-header"]'
        );
        if (labelEl) {
          const labelText = labelEl.textContent.trim().toLowerCase();
          if (labelText && labelText.length < 30 && /^[\w+#.-]+$/.test(labelText)) {
            return labelText;
          }
        }
      }

      return '';
    },

    /**
     * Extracts all code blocks from a message block.
     *
     * @param {Element} block - The message block element
     * @returns {Array<{language: string, code: string, fileName: string|null}>}
     * @private
     */
    _extractCodeBlocks(block) {
      const codeBlocks = [];

      try {
        const preElements = block.querySelectorAll('pre');

        for (const pre of preElements) {
          const codeEl = pre.querySelector('code') || pre;
          const language = this._detectLanguageFromElement(codeEl);
          const code = (codeEl.textContent || '').trim();

          if (code.length > 0) {
            // Try to detect a filename from the code block header
            let fileName = null;
            const headerEl = pre.parentElement?.querySelector(
              '[class*="filename"], [class*="file-name"], [class*="code-title"]'
            );
            if (headerEl) {
              const headerText = headerEl.textContent.trim();
              if (headerText && headerText.length < 100 && /\.\w+$/.test(headerText)) {
                fileName = headerText;
              }
            }

            codeBlocks.push({ language, code, fileName });
          }
        }
      } catch (error) {
        console.error('[Claude Extractor] Error extracting code blocks:', error);
      }

      return codeBlocks;
    },

    /**
     * Extracts Anthropic "Artifact" nodes from a message block.
     * Artifacts are special interactive components that Claude can create,
     * containing full documents, applications, or code files.
     *
     * @param {Element} block - The message block element
     * @returns {Array<{title: string, language: string, code: string, type: string}>}
     * @private
     */
    _extractArtifacts(block) {
      const artifacts = [];

      try {
        const artifactNodes = querySelectorAllWithFallback(
          CONFIG.SELECTORS.ARTIFACT_CANDIDATES,
          block
        );

        for (const artifactNode of artifactNodes) {
          // Extract artifact title
          const titleEl = artifactNode.querySelector(
            '[class*="title"], h1, h2, h3, [data-testid*="title"]'
          );
          const title = titleEl?.textContent?.trim() || 'Untitled Artifact';

          // Extract artifact type
          const type = artifactNode.getAttribute('data-artifact-type') ||
                      artifactNode.getAttribute('data-type') ||
                      'unknown';

          // Extract code content from the artifact
          const codeEl = artifactNode.querySelector('pre code, code, [class*="code"]');
          const code = codeEl?.textContent?.trim() || artifactNode.textContent?.trim() || '';

          // Detect language
          const language = this._detectLanguageFromElement(codeEl || artifactNode);

          if (code.length > 0) {
            artifacts.push({ title, language, code, type });
          }
        }
      } catch (error) {
        console.error('[Claude Extractor] Error extracting artifacts:', error);
      }

      return artifacts;
    },
  };

  // =========================================================================
  // SECTION 4: SHADOW DOM UI INJECTION
  // =========================================================================

  /**
   * UIManager handles injection and lifecycle of the extraction UI controls.
   * Uses a closed Shadow DOM for complete CSS isolation from Anthropic's styles.
   */
  const UIManager = {
    /** @type {HTMLElement|null} Host element for the shadow root */
    _hostElement: null,

    /** @type {ShadowRoot|null} The closed shadow root */
    _shadowRoot: null,

    /** @type {boolean} Whether the panel is currently expanded */
    _isExpanded: false,

    /** @type {boolean} Whether an export operation is in progress */
    _isExporting: false,

    /**
     * Mounts the UI into the page, creating the Shadow DOM host and
     * injecting all UI elements and styles.
     */
    mount() {
      // Prevent duplicate injection
      if (document.getElementById(CONFIG.INJECTED_MARKER)) {
        console.log('[Claude Extractor] UI already mounted. Skipping.');
        return;
      }

      try {
        // Create host element
        this._hostElement = document.createElement('div');
        this._hostElement.id = CONFIG.INJECTED_MARKER;
        this._hostElement.setAttribute('aria-label', 'Claude Extractor Suite Controls');

        // Attach closed Shadow DOM for full encapsulation
        this._shadowRoot = this._hostElement.attachShadow({ mode: 'closed' });

        // Inject styles
        this._injectStyles();

        // Build UI components
        this._buildUI();

        // Mount to document
        document.body.appendChild(this._hostElement);

        console.log('[Claude Extractor] UI mounted successfully.');
      } catch (mountError) {
        console.error('[Claude Extractor] Failed to mount UI:', mountError);
      }
    },

    /**
     * Unmounts the UI from the page, cleaning up event listeners.
     */
    unmount() {
      if (this._hostElement && this._hostElement.parentNode) {
        this._hostElement.parentNode.removeChild(this._hostElement);
        this._hostElement = null;
        this._shadowRoot = null;
        this._isExpanded = false;
        console.log('[Claude Extractor] UI unmounted.');
      }
    },

    /**
     * Injects the CSS stylesheet into the Shadow DOM.
     * @private
     */
    _injectStyles() {
      const styleEl = document.createElement('style');
      styleEl.textContent = this._getStyles();
      this._shadowRoot.appendChild(styleEl);
    },

    /**
     * Returns the complete CSS for the Shadow DOM UI.
     * Fully self-contained — no external stylesheet dependencies.
     *
     * @returns {string} CSS string
     * @private
     */
    _getStyles() {
      return `
        /* ============================================================
           CLAUDE EXTRACTOR SUITE — Shadow DOM Styles
           ============================================================ */

        :host {
          all: initial;
          position: fixed;
          bottom: 24px;
          right: 24px;
          z-index: 2147483647;
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto,
                       'Helvetica Neue', Arial, sans-serif;
          font-size: 14px;
          line-height: 1.5;
          color: #e2e8f0;
        }

        *, *::before, *::after {
          box-sizing: border-box;
          margin: 0;
          padding: 0;
        }

        /* --- FAB (Floating Action Button) --- */
        .extractor-fab {
          width: 56px;
          height: 56px;
          border-radius: 50%;
          border: none;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          background: linear-gradient(135deg, #d97706 0%, #b45309 100%);
          box-shadow:
            0 4px 14px rgba(217, 119, 6, 0.4),
            0 2px 6px rgba(0, 0, 0, 0.2);
          transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
          position: relative;
          overflow: hidden;
        }

        .extractor-fab:hover {
          transform: scale(1.08);
          box-shadow:
            0 6px 20px rgba(217, 119, 6, 0.5),
            0 3px 8px rgba(0, 0, 0, 0.3);
        }

        .extractor-fab:active {
          transform: scale(0.96);
        }

        .extractor-fab.is-open {
          background: linear-gradient(135deg, #6b7280 0%, #4b5563 100%);
          box-shadow:
            0 4px 14px rgba(107, 114, 128, 0.4),
            0 2px 6px rgba(0, 0, 0, 0.2);
        }

        .extractor-fab svg {
          width: 24px;
          height: 24px;
          fill: white;
          transition: transform 0.3s ease;
        }

        .extractor-fab.is-open svg {
          transform: rotate(45deg);
        }

        /* --- Panel --- */
        .extractor-panel {
          position: absolute;
          bottom: 68px;
          right: 0;
          width: 300px;
          background: #1e293b;
          border: 1px solid #334155;
          border-radius: 16px;
          padding: 0;
          opacity: 0;
          transform: translateY(12px) scale(0.95);
          pointer-events: none;
          transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
          overflow: hidden;
          box-shadow:
            0 20px 40px rgba(0, 0, 0, 0.4),
            0 8px 16px rgba(0, 0, 0, 0.2);
        }

        .extractor-panel.is-visible {
          opacity: 1;
          transform: translateY(0) scale(1);
          pointer-events: all;
        }

        /* --- Panel Header --- */
        .panel-header {
          padding: 16px 20px 12px;
          border-bottom: 1px solid #334155;
          display: flex;
          align-items: center;
          gap: 10px;
        }

        .panel-header-icon {
          width: 20px;
          height: 20px;
          fill: #d97706;
          flex-shrink: 0;
        }

        .panel-header h3 {
          font-size: 13px;
          font-weight: 600;
          color: #f1f5f9;
          letter-spacing: 0.02em;
          text-transform: uppercase;
        }

        /* --- Panel Body --- */
        .panel-body {
          padding: 16px 20px 20px;
          display: flex;
          flex-direction: column;
          gap: 10px;
        }

        /* --- Export Buttons --- */
        .export-btn {
          width: 100%;
          padding: 12px 16px;
          border: 1px solid transparent;
          border-radius: 10px;
          cursor: pointer;
          font-family: inherit;
          font-size: 13px;
          font-weight: 500;
          display: flex;
          align-items: center;
          gap: 10px;
          transition: all 0.2s ease;
          position: relative;
          overflow: hidden;
        }

        .export-btn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .export-btn svg {
          width: 18px;
          height: 18px;
          flex-shrink: 0;
        }

        .export-btn .btn-text {
          display: flex;
          flex-direction: column;
          align-items: flex-start;
        }

        .export-btn .btn-label {
          font-weight: 600;
          line-height: 1.3;
        }

        .export-btn .btn-desc {
          font-size: 11px;
          opacity: 0.7;
          line-height: 1.3;
        }

        /* Markdown Export Button */
        .export-btn--md {
          background: linear-gradient(135deg, #1e3a5f 0%, #172554 100%);
          color: #93c5fd;
          border-color: #1e40af33;
        }

        .export-btn--md:hover:not(:disabled) {
          background: linear-gradient(135deg, #1e40af 0%, #1e3a8a 100%);
          border-color: #3b82f655;
          box-shadow: 0 4px 12px rgba(59, 130, 246, 0.25);
        }

        .export-btn--md svg {
          fill: #60a5fa;
        }

        /* ZIP Export Button */
        .export-btn--zip {
          background: linear-gradient(135deg, #14532d 0%, #052e16 100%);
          color: #86efac;
          border-color: #16a34a33;
        }

        .export-btn--zip:hover:not(:disabled) {
          background: linear-gradient(135deg, #15803d 0%, #14532d 100%);
          border-color: #22c55e55;
          box-shadow: 0 4px 12px rgba(34, 197, 94, 0.25);
        }

        .export-btn--zip svg {
          fill: #4ade80;
        }

        /* --- Status Bar --- */
        .panel-status {
          padding: 0 20px 16px;
          font-size: 11px;
          color: #94a3b8;
          min-height: 18px;
          transition: color 0.2s ease;
        }

        .panel-status.is-error {
          color: #f87171;
        }

        .panel-status.is-success {
          color: #4ade80;
        }

        /* --- Spinner Animation --- */
        .spinner {
          display: inline-block;
          width: 14px;
          height: 14px;
          border: 2px solid currentColor;
          border-top-color: transparent;
          border-radius: 50%;
          animation: spin 0.6s linear infinite;
          margin-right: 6px;
          vertical-align: middle;
        }

        @keyframes spin {
          to { transform: rotate(360deg); }
        }

        /* --- Tooltip on FAB --- */
        .fab-tooltip {
          position: absolute;
          right: 64px;
          bottom: 50%;
          transform: translateY(50%);
          background: #0f172a;
          color: #e2e8f0;
          font-size: 12px;
          padding: 6px 12px;
          border-radius: 8px;
          white-space: nowrap;
          pointer-events: none;
          opacity: 0;
          transition: opacity 0.2s ease;
          box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
          border: 1px solid #334155;
        }

        .extractor-fab:hover + .fab-tooltip,
        .extractor-fab:focus + .fab-tooltip {
          opacity: 1;
        }

        .extractor-fab.is-open:hover + .fab-tooltip,
        .extractor-fab.is-open:focus + .fab-tooltip {
          opacity: 0;
        }

        /* --- Responsive adjustments for small viewports --- */
        @media (max-width: 480px) {
          :host {
            bottom: 16px;
            right: 16px;
          }

          .extractor-panel {
            width: 260px;
          }
        }

        /* --- Focus styles for accessibility --- */
        .extractor-fab:focus-visible,
        .export-btn:focus-visible {
          outline: 2px solid #d97706;
          outline-offset: 2px;
        }
      `;
    },

    /**
     * Builds the complete UI component tree within the Shadow DOM.
     * @private
     */
    _buildUI() {
      const wrapper = document.createElement('div');
      wrapper.className = 'extractor-wrapper';

      // --- Panel ---
      const panel = document.createElement('div');
      panel.className = 'extractor-panel';
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-label', 'Export Options');

      // Panel Header
      const header = document.createElement('div');
      header.className = 'panel-header';
      header.innerHTML = `
        <svg class="panel-header-icon" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6zm-1 9V3.5L18.5 9H13zM6 4h6v6h6v10H6V4z"/>
        </svg>
        <h3>Claude Extractor</h3>
      `;
      panel.appendChild(header);

      // Panel Body
      const body = document.createElement('div');
      body.className = 'panel-body';

      // Markdown Export Button
      const mdBtn = document.createElement('button');
      mdBtn.className = 'export-btn export-btn--md';
      mdBtn.setAttribute('type', 'button');
      mdBtn.setAttribute('aria-label', 'Export conversation to Markdown');
      mdBtn.innerHTML = `
        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
          <path d="M20.56 18H3.44C2.65 18 2 17.37 2 16.59V7.41C2 6.63 2.65 6 3.44 6h17.12c.79 0 1.44.63 1.44 1.41v9.18c0 .78-.65 1.41-1.44 1.41zM6 15.5v-3.5l1.5 2 1.5-2v3.5h1.5v-7H9L7.5 10.5 6 8.5H4.5v7H6zm9.5-7H13v7h1.5v-3.5l1.5 1.75 1.5-1.75V15.5H19v-7h-2.5L15 10.25 13.5 8.5z"/>
        </svg>
        <span class="btn-text">
          <span class="btn-label">Export to Obsidian (MD)</span>
          <span class="btn-desc">Full conversation with YAML frontmatter</span>
        </span>
      `;
      body.appendChild(mdBtn);

      // ZIP Export Button
      const zipBtn = document.createElement('button');
      zipBtn.className = 'export-btn export-btn--zip';
      zipBtn.setAttribute('type', 'button');
      zipBtn.setAttribute('aria-label', 'Extract all code blocks as ZIP archive');
      zipBtn.innerHTML = `
        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
          <path d="M20 6h-8l-2-2H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm-6 10h-2v2h-1v-2H9v-1h2v-2h1v2h2v1zm0-4H9V8h1v1h1V8h1v1h1V8h1v4z"/>
        </svg>
        <span class="btn-text">
          <span class="btn-label">Extract Codebase (ZIP)</span>
          <span class="btn-desc">All code blocks as separate files</span>
        </span>
      `;
      body.appendChild(zipBtn);

      panel.appendChild(body);

      // Status Bar
      const status = document.createElement('div');
      status.className = 'panel-status';
      status.textContent = '';
      panel.appendChild(status);

      wrapper.appendChild(panel);

      // --- FAB ---
      const fab = document.createElement('button');
      fab.className = 'extractor-fab';
      fab.setAttribute('type', 'button');
      fab.setAttribute('aria-label', 'Toggle Claude Extractor panel');
      fab.setAttribute('aria-expanded', 'false');
      fab.innerHTML = `
        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
          <path d="M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z"/>
        </svg>
      `;
      wrapper.appendChild(fab);

      // Tooltip
      const tooltip = document.createElement('div');
      tooltip.className = 'fab-tooltip';
      tooltip.textContent = 'Claude Extractor';
      wrapper.appendChild(tooltip);

      // --- Event Listeners ---

      // FAB toggle
      fab.addEventListener('click', () => {
        this._isExpanded = !this._isExpanded;
        panel.classList.toggle('is-visible', this._isExpanded);
        fab.classList.toggle('is-open', this._isExpanded);
        fab.setAttribute('aria-expanded', String(this._isExpanded));
      });

      // Close panel when clicking outside (listen on document)
      document.addEventListener('click', (event) => {
        if (this._isExpanded && !this._hostElement.contains(event.target)) {
          this._isExpanded = false;
          panel.classList.remove('is-visible');
          fab.classList.remove('is-open');
          fab.setAttribute('aria-expanded', 'false');
        }
      });

      // Markdown Export — debounced
      const handleMdExport = debounce(async () => {
        this._setStatus(status, 'Parsing conversation...', 'default');
        this._setButtonsDisabled([mdBtn, zipBtn], true);

        try {
          const { messages, metadata } = ConversationParser.parse();

          if (messages.length === 0) {
            this._setStatus(status, 'No messages found. Is this a chat page?', 'error');
            return;
          }

          this._setStatus(status, `Found ${messages.length} messages. Generating Markdown...`, 'default');

          const markdown = ExportUtils.generateMarkdown(messages, metadata);
          const filename = ExportUtils.sanitizeFilename(metadata.title) + '.md';

          ExportUtils.downloadBlob(
            new Blob([markdown], { type: 'text/markdown;charset=utf-8' }),
            filename
          );

          this._setStatus(status, `✓ Exported ${messages.length} messages to ${filename}`, 'success');
        } catch (error) {
          console.error('[Claude Extractor] Markdown export failed:', error);
          this._setStatus(status, `Export failed: ${error.message}`, 'error');
        } finally {
          this._setButtonsDisabled([mdBtn, zipBtn], false);
        }
      }, CONFIG.DEBOUNCE_MS);

      mdBtn.addEventListener('click', handleMdExport);

      // ZIP Export — debounced
      const handleZipExport = debounce(async () => {
        // Verify JSZip is available
        if (typeof JSZip === 'undefined') {
          this._setStatus(status, 'JSZip library not loaded. Cannot create ZIP.', 'error');
          console.error('[Claude Extractor] JSZip is not defined. Ensure lib/jszip.min.js is bundled.');
          return;
        }

        this._setStatus(status, 'Parsing conversation for code blocks...', 'default');
        this._setButtonsDisabled([mdBtn, zipBtn], true);

        try {
          const { messages, metadata } = ConversationParser.parse();

          // Collect all code blocks and artifacts
          const allCodeBlocks = [];
          for (const msg of messages) {
            for (const block of msg.codeBlocks) {
              allCodeBlocks.push(block);
            }
            for (const artifact of msg.artifacts) {
              allCodeBlocks.push({
                language: artifact.language,
                code: artifact.code,
                fileName: artifact.title,
              });
            }
          }

          if (allCodeBlocks.length === 0) {
            this._setStatus(status, 'No code blocks found in this conversation.', 'error');
            return;
          }

          this._setStatus(status, `Found ${allCodeBlocks.length} code blocks. Creating ZIP...`, 'default');

          const zipBlob = await ExportUtils.generateZip(allCodeBlocks, metadata);
          const filename = ExportUtils.sanitizeFilename(metadata.title) + '_codebase.zip';

          ExportUtils.downloadBlob(zipBlob, filename);

          this._setStatus(
            status,
            `✓ Extracted ${allCodeBlocks.length} files to ${filename}`,
            'success'
          );
        } catch (error) {
          console.error('[Claude Extractor] ZIP export failed:', error);
          this._setStatus(status, `ZIP export failed: ${error.message}`, 'error');
        } finally {
          this._setButtonsDisabled([mdBtn, zipBtn], false);
        }
      }, CONFIG.DEBOUNCE_MS);

      zipBtn.addEventListener('click', handleZipExport);

      // Append to Shadow DOM
      this._shadowRoot.appendChild(wrapper);
    },

    /**
     * Updates the status bar text and style.
     *
     * @param {HTMLElement} statusEl - The status bar element
     * @param {string} message - Status message text
     * @param {'default'|'error'|'success'} type - Status type for styling
     * @private
     */
    _setStatus(statusEl, message, type = 'default') {
      statusEl.textContent = message;
      statusEl.classList.remove('is-error', 'is-success');
      if (type === 'error') statusEl.classList.add('is-error');
      if (type === 'success') statusEl.classList.add('is-success');
    },

    /**
     * Enables or disables export buttons during processing.
     *
     * @param {HTMLElement[]} buttons - Array of button elements
     * @param {boolean} disabled - Whether to disable the buttons
     * @private
     */
    _setButtonsDisabled(buttons, disabled) {
      for (const btn of buttons) {
        btn.disabled = disabled;
      }
    },
  };

  // =========================================================================
  // SECTION 5: SPA ROUTE OBSERVER & INITIALIZATION
  // =========================================================================

  /**
   * SPAObserver monitors claude.ai for route changes (it's a React SPA)
   * and manages the lifecycle of the extractor UI.
   *
   * Strategies for detecting route changes:
   * 1. URL polling (since pushState/replaceState don't fire events)
   * 2. MutationObserver on the document body for major DOM mutations
   *    that indicate page transitions
   */
  const SPAObserver = {
    /** @type {string|null} Last known URL */
    _lastUrl: null,

    /** @type {number|null} Polling interval ID */
    _pollIntervalId: null,

    /** @type {MutationObserver|null} DOM mutation observer */
    _mutationObserver: null,

    /**
     * Starts monitoring for SPA route changes.
     */
    start() {
      this._lastUrl = window.location.href;

      // --- URL Polling ---
      // React Router uses pushState which doesn't fire 'popstate' on navigation.
      // We poll the URL to detect changes.
      this._pollIntervalId = setInterval(() => {
        const currentUrl = window.location.href;
        if (currentUrl !== this._lastUrl) {
          console.log(`[Claude Extractor] Route change detected: ${this._lastUrl} → ${currentUrl}`);
          this._lastUrl = currentUrl;
          this._onRouteChange(currentUrl);
        }
      }, CONFIG.ROUTE_POLL_INTERVAL_MS);

      // --- popstate listener (for browser back/forward) ---
      window.addEventListener('popstate', () => {
        setTimeout(() => {
          const currentUrl = window.location.href;
          if (currentUrl !== this._lastUrl) {
            this._lastUrl = currentUrl;
            this._onRouteChange(currentUrl);
          }
        }, 100);
      });

      // --- MutationObserver for lazy-loaded content ---
      // Watch for major DOM subtree changes that indicate the chat has loaded
      this._mutationObserver = new MutationObserver((mutations) => {
        // Look for mutations that add significant content (message blocks)
        for (const mutation of mutations) {
          if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
            for (const node of mutation.addedNodes) {
              if (node.nodeType === Node.ELEMENT_NODE) {
                // Check if a chat container or message was added
                const isRelevant = node.querySelector?.('pre, p, [role="log"]');
                if (isRelevant && !document.getElementById(CONFIG.INJECTED_MARKER)) {
                  console.log('[Claude Extractor] Significant DOM mutation detected. Attempting mount.');
                  this._attemptMount();
                  return;
                }
              }
            }
          }
        }
      });

      this._mutationObserver.observe(document.body, {
        childList: true,
        subtree: true,
      });

      // Initial mount
      this._attemptMount();
    },

    /**
     * Handles SPA route changes by unmounting and remounting the UI
     * on chat pages.
     *
     * @param {string} url - The new URL
     * @private
     */
    _onRouteChange(url) {
      // Unmount existing UI
      UIManager.unmount();

      // Only mount on chat pages
      if (this._isChatPage(url)) {
        // Wait for the new chat content to render
        setTimeout(() => this._attemptMount(), 500);
      }
    },

    /**
     * Determines if the current URL is a Claude chat page.
     *
     * @param {string} url - URL to check
     * @returns {boolean}
     * @private
     */
    _isChatPage(url) {
      // Claude.ai chat URLs typically match:
      // https://claude.ai/chat/{uuid}
      // https://claude.ai/new (new chat)
      // We mount on any claude.ai page to be safe
      return /^https:\/\/claude\.ai/i.test(url);
    },

    /**
     * Attempts to mount the UI, with retries for lazy-loaded content.
     * @private
     */
    async _attemptMount() {
      if (document.getElementById(CONFIG.INJECTED_MARKER)) {
        return; // Already mounted
      }

      if (!this._isChatPage(window.location.href)) {
        return; // Not a chat page
      }

      // Wait for the page to have meaningful content
      const chatContainer = await waitForElement(
        CONFIG.SELECTORS.CHAT_CONTAINER_CANDIDATES,
        CONFIG.MAX_MOUNT_RETRIES,
        CONFIG.MOUNT_RETRY_DELAY_MS
      );

      if (chatContainer) {
        UIManager.mount();
      } else {
        // Mount anyway — the user might still want to use the tool,
        // and the parser will report "no messages found" if it can't find content
        console.warn('[Claude Extractor] Chat container not found, but mounting UI anyway.');
        UIManager.mount();
      }
    },

    /**
     * Stops all monitoring and cleans up resources.
     */
    stop() {
      if (this._pollIntervalId) {
        clearInterval(this._pollIntervalId);
        this._pollIntervalId = null;
      }
      if (this._mutationObserver) {
        this._mutationObserver.disconnect();
        this._mutationObserver = null;
      }
      UIManager.unmount();
    },
  };

  // =========================================================================
  // SECTION 6: BOOTSTRAP
  // =========================================================================

  /**
   * Entry point. Wait for the DOM to be ready, then start the observer.
   */
  function bootstrap() {
    console.log('[Claude Extractor] Initializing Power-User Archival & Code Extraction Suite v1.0.0');

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => SPAObserver.start());
    } else {
      SPAObserver.start();
    }
  }

  // Launch
  bootstrap();

})();
