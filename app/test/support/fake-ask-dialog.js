'use strict';

// A stand-in for Claude Code's AskUserQuestion dialog whose every transition
// was MEASURED against the real CLI (v2.1.258, isolated pty at 120x60,
// 2026-09-03; the screens it renders are the shapes of the
// test/fixtures/askuserquestion/real-batch-*-2.1.258.txt captures):
//
//   →  / ←         next / previous question; ← on the first stays put
//   ↑  / ↓         move the "❯" over the rows of THIS question
//   Enter          single-select: answer with the row and ADVANCE (the answered
//                  tab flips to ☒); on the text row with text: the same; on the
//                  text row with nothing typed: declines EVERY question
//                  multi-select: on an option row TOGGLES it; on the confirm
//                  row confirms the ticks and advances
//   Space          multi-select: toggles the row (first tick flips the tab ☒)
//   typing         on the text row rewrites the row's label
//   Esc            declines every question
//   after the last question: the review screen, "1. Submit answers / 2. Cancel"
//
// It renders the tab strip, the question, the numbered rows, the unnumbered
// confirm row, the divider, "Chat about this" and the footer exactly as the
// CLI draws them, so menu-parse.js is exercised for real rather than stubbed.

const KEYS = { up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D', enter: '\r', esc: '\x1b', space: ' ' };
const PASTE_RE = /^\x1b\[200~([\s\S]*)\x1b\[201~$/;
const DIVIDER = '─'.repeat(120);

class FakeAskDialog {
  constructor(questions, { startAt = 0 } = {}) {
    this.questions = questions.map((question) => ({
      header: question.header || '',
      question: question.question || '',
      multiSelect: Boolean(question.multiSelect),
      options: (question.options || []).map((option) => ({
        label: typeof option === 'string' ? option : option.label,
        description: typeof option === 'string' ? '' : (option.description || ''),
      })),
    }));
    this.q = startAt;
    this.stage = 'questions'; // 'questions' | 'review' | 'closed'
    this.hl = this.questions.map(() => 1);
    this.ticks = this.questions.map(() => new Set());
    this.typed = this.questions.map(() => '');
    this.answers = this.questions.map(() => null);
    this.reviewHl = 1;
    this.outcome = null;
    this.keys = [];
    // A harness knob: swallow the next N Enters, the way a keystroke the
    // bridge accepted but the CLI never saw would behave.
    this.dropEnters = 0;
  }

  // Row numbering for question qi: 1..N options, N+1 text row, then (multi
  // only) the unnumbered confirm row at position N+2, and Chat at the end.
  rowCount(qi) {
    const question = this.questions[qi];
    return question.options.length + 1 + (question.multiSelect ? 1 : 0) + 1;
  }
  isConfirmRow(qi, pos) {
    const question = this.questions[qi];
    return question.multiSelect && pos === question.options.length + 2;
  }
  isChatRow(qi, pos) { return pos === this.rowCount(qi); }
  isTextRow(qi, pos) { return pos === this.questions[qi].options.length + 1; }

  input(bytes) {
    this.keys.push(bytes);
    if (this.stage === 'closed') return;
    const paste = PASTE_RE.exec(bytes);
    if (paste) { this.type(paste[1]); return; }
    switch (bytes) {
      case KEYS.up: this.move(-1); return;
      case KEYS.down: this.move(1); return;
      case KEYS.right: this.hop(1); return;
      case KEYS.left: this.hop(-1); return;
      case KEYS.enter:
        if (this.dropEnters > 0) { this.dropEnters -= 1; return; }
        this.enter();
        return;
      case KEYS.esc: this.close('declined'); return;
      case KEYS.space: this.space(); return;
      default: this.type(bytes);
    }
  }

  move(dir) {
    if (this.stage === 'review') { this.reviewHl = Math.min(2, Math.max(1, this.reviewHl + dir)); return; }
    const max = this.rowCount(this.q);
    this.hl[this.q] = Math.min(max, Math.max(1, this.hl[this.q] + dir));
  }

  hop(dir) {
    const last = this.questions.length; // position `last` is the review screen
    let at = this.stage === 'review' ? last : this.q;
    at = Math.min(last, Math.max(0, at + dir));
    if (this.questions.length === 1) return; // a lone question has no strip
    if (at === last) { this.stage = 'review'; return; }
    this.stage = 'questions';
    this.q = at;
  }

  space() {
    if (this.stage !== 'questions') return;
    const question = this.questions[this.q];
    if (!question.multiSelect) return;
    const pos = this.hl[this.q];
    if (pos <= question.options.length || this.isTextRow(this.q, pos)) {
      if (this.ticks[this.q].has(pos)) this.ticks[this.q].delete(pos);
      else this.ticks[this.q].add(pos);
    }
  }

  type(text) {
    if (this.stage !== 'questions') return;
    const pos = this.hl[this.q];
    if (!this.isTextRow(this.q, pos)) return;
    this.typed[this.q] += text;
    if (this.questions[this.q].multiSelect) this.ticks[this.q].add(pos);
  }

  enter() {
    if (this.stage === 'review') {
      if (this.reviewHl === 1) this.close('submitted');
      else this.close('cancelled');
      return;
    }
    const qi = this.q;
    const question = this.questions[qi];
    const pos = this.hl[qi];
    if (this.isChatRow(qi, pos)) { this.close('chat'); return; }
    if (question.multiSelect) {
      if (this.isConfirmRow(qi, pos)) {
        const labels = [...this.ticks[qi]].sort((a, b) => a - b)
          .map((p) => (this.isTextRow(qi, p) ? this.typed[qi] : question.options[p - 1].label));
        this.answers[qi] = labels.join(', ');
        this.advance();
        return;
      }
      if (this.isTextRow(qi, pos)) {
        // Measured 2026-08-09: Enter on the text row of a multi-select UNTICKS it.
        this.ticks[qi].delete(pos);
        return;
      }
      if (this.ticks[qi].has(pos)) this.ticks[qi].delete(pos); else this.ticks[qi].add(pos);
      return;
    }
    if (this.isTextRow(qi, pos)) {
      if (!this.typed[qi]) { this.close('declined'); return; }
      this.answers[qi] = this.typed[qi];
      this.advance();
      return;
    }
    this.answers[qi] = question.options[pos - 1].label;
    this.advance();
  }

  advance() {
    if (this.questions.length === 1) { this.close('submitted'); return; }
    if (this.q + 1 >= this.questions.length) this.stage = 'review';
    else this.q += 1;
  }

  // What the review lists for a question: its confirmed answer, or for a
  // multi-select its ticks even when its Submit row was never pressed (the
  // 2026-08-09 review fixture lists "Beta one, Beta two" for a question that
  // was only ticked).
  reviewAnswer(qi) {
    if (this.answers[qi] != null) return this.answers[qi];
    const question = this.questions[qi];
    if (!question.multiSelect || this.ticks[qi].size === 0) return null;
    return [...this.ticks[qi]].sort((a, b) => a - b)
      .map((p) => (this.isTextRow(qi, p) ? this.typed[qi] : question.options[p - 1].label)).join(', ');
  }

  close(outcome) {
    this.stage = 'closed';
    this.outcome = outcome;
    if (outcome === 'submitted') this.answers = this.questions.map((_q, i) => this.reviewAnswer(i));
  }

  answeredMark(qi) {
    const question = this.questions[qi];
    const touched = question.multiSelect ? this.ticks[qi].size > 0 : this.answers[qi] != null;
    return touched ? '☒' : '☐';
  }

  screen() {
    if (this.stage === 'closed') {
      return ['● User answered Claude\'s questions:', '', DIVIDER, '❯', DIVIDER, '  personal  ·  Haiku 4.5'].join('\n');
    }
    const strip = this.questions.length > 1
      ? `←  ${this.questions.map((question, i) => `${this.answeredMark(i)} ${question.header}`).join('  ')}  ✔ Submit  →`
      : null;
    if (this.stage === 'review') {
      // As the CLI draws it: a warning when questions are unanswered, and only
      // the answered ones listed (fixture real-batch-submit-review-120x60.txt).
      const lines = [DIVIDER, strip, 'Review your answers'];
      const listed = this.questions.map((_q, i) => this.reviewAnswer(i));
      if (listed.some((answer) => answer == null)) lines.push('⚠ You have not answered all questions');
      this.questions.forEach((question, i) => {
        if (listed[i] == null) return;
        lines.push(` ● ${question.question}`);
        lines.push(`   → ${listed[i]}`);
      });
      lines.push('Ready to submit your answers?');
      lines.push(`${this.reviewHl === 1 ? '❯' : ' '} 1. Submit answers`);
      lines.push(`${this.reviewHl === 2 ? '❯' : ' '} 2. Cancel`);
      return lines.filter((line) => line != null).join('\n');
    }
    const qi = this.q;
    const question = this.questions[qi];
    const pos = this.hl[qi];
    const lines = [DIVIDER];
    if (strip) lines.push(strip);
    else lines.push(` ☐ ${question.header}`);
    lines.push(question.question);
    question.options.forEach((option, i) => {
      const n = i + 1;
      const box = question.multiSelect ? `[${this.ticks[qi].has(n) ? '✔' : ' '}] ` : '';
      lines.push(`${pos === n ? '❯' : ' '} ${n}. ${box}${option.label}`);
      if (option.description) lines.push(`     ${option.description}`);
    });
    const textPos = question.options.length + 1;
    const textLabel = this.typed[qi] || (question.multiSelect ? 'Type something' : 'Type something.');
    const textBox = question.multiSelect ? `[${this.ticks[qi].has(textPos) ? '✔' : ' '}] ` : '';
    lines.push(`${pos === textPos ? '❯' : ' '} ${textPos}. ${textBox}${textLabel}`);
    if (question.multiSelect) {
      lines.push(`${pos === textPos + 1 ? '❯' : ' '}    ${qi + 1 < this.questions.length ? 'Next' : 'Submit'}`);
    }
    lines.push(DIVIDER);
    const chatPos = this.rowCount(qi);
    lines.push(`${pos === chatPos ? '❯' : ' '} ${textPos + 1}. Chat about this`);
    // The footer grows "ctrl+g to edit in Notepad" while the pointer is on the
    // text row or the confirm row (fixtures real-batch-text-typed-2.1.258.txt,
    // real-batch-confirm-row-2.1.258.txt).
    const editHint = (pos === textPos || (question.multiSelect && pos === textPos + 1)) ? ' · ctrl+g to edit in Notepad' : '';
    lines.push(this.questions.length > 1
      ? `Enter to select · Tab/Arrow keys to navigate${editHint} · Esc to cancel`
      : `Enter to select · ↑/↓ to navigate${editHint} · Esc to cancel`);
    return lines.join('\n');
  }
}

module.exports = { FakeAskDialog, KEYS };
