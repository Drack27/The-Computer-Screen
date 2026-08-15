/* Small DOM helpers and the one dialog everything else is built from.
 *
 * The form builder is the important part: every editor in the app is a list of
 * field descriptors handed to `formDialog`, which keeps the editors honest and
 * makes adding a field to a record a one-line change.
 */

export const $ = (id) => document.getElementById(id);

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

/** Build a node tree from a compact spec — el('div', 'x', [child, child]). */
export function tree(tag, className, children = []) {
  const node = el(tag, className);
  for (const child of children) {
    if (child == null || child === false) continue;
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export function button(label, { className = '', title = '', onClick = null, disabled = false } = {}) {
  const node = el('button', className, label);
  if (title) node.title = title;
  if (disabled) node.disabled = true;
  if (onClick) node.addEventListener('click', onClick);
  return node;
}

// ── Toast ────────────────────────────────────────────────────────────────────

let toastTimer = null;

export function toast(message, kind = 'info') {
  const node = $('toast');
  if (!node) return;
  node.textContent = message;
  node.className = kind;
  node.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.add('hidden'), kind === 'error' ? 4200 : 2400);
}

// ── Modal ────────────────────────────────────────────────────────────────────

let closeCurrentModal = null;

export function isModalOpen() {
  return !!closeCurrentModal;
}

export function hideModal() {
  if (closeCurrentModal) closeCurrentModal();
}

/** The base dialog. `body` is a node; `actions` are buttons drawn right to left
 *  in the footer. Returns a function that closes it. */
export function modal({ title, body, actions = [], onClose = null, wide = false }) {
  hideModal();

  const overlay = $('modal-overlay');
  const box = $('modal-box');
  box.classList.toggle('wide', !!wide);

  $('modal-header').textContent = title || '';
  clear($('modal-body')).appendChild(body);

  const footer = clear($('modal-footer'));
  for (const action of actions) {
    footer.appendChild(button(action.label, {
      className: action.primary ? 'primary' : (action.danger ? 'danger' : ''),
      onClick: () => action.onClick(),
    }));
  }

  overlay.classList.remove('hidden');

  const onOverlayClick = (event) => { if (event.target === overlay) close(); };
  overlay.addEventListener('mousedown', onOverlayClick);

  function close() {
    overlay.classList.add('hidden');
    overlay.removeEventListener('mousedown', onOverlayClick);
    clear($('modal-body'));
    closeCurrentModal = null;
    if (onClose) onClose();
  }

  closeCurrentModal = close;
  return close;
}

export function confirmDialog({ title, message, confirmLabel = 'Confirm', danger = false }) {
  return new Promise((resolve) => {
    // Dismissing with Escape or the overlay counts as "no", so settle on close
    // and let the confirm button set the answer on its way out.
    let answer = false;
    const close = modal({
      title,
      body: el('div', 'modal-message', message),
      onClose: () => resolve(answer),
      actions: [
        { label: 'Cancel', onClick: () => close() },
        { label: confirmLabel, primary: !danger, danger, onClick: () => { answer = true; close(); } },
      ],
    });
  });
}

// ── Form dialog ──────────────────────────────────────────────────────────────

/**
 * Field descriptor:
 *   { key, label, type, value, options, hint, required, rows, placeholder, when }
 *
 * type: 'text' | 'textarea' | 'number' | 'select' | 'checkbox' | 'color'
 *     | 'date' | 'group' | 'heading' | 'custom'
 *
 * 'date' fields need `calendar` — a Calendar instance — and carry "Y-M-D".
 * 'custom' fields supply `render(setValue, currentValue)` returning a node.
 */
export function formDialog({ title, fields, confirmLabel = 'Save', wide = false, onSubmit, extraActions = [] }) {
  const values = {};
  const controls = new Map();
  const form = el('form', 'form');

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    submit();
  });

  for (const field of fields) {
    if (!field) continue;
    if (field.type === 'heading') {
      form.appendChild(el('div', 'form-heading', field.label));
      continue;
    }
    values[field.key] = field.value ?? defaultFor(field);
    const row = buildRow(field, values, controls);
    form.appendChild(row);
  }

  // Re-evaluate `when` predicates so dependent fields can appear and vanish.
  function refreshVisibility() {
    for (const [key, control] of controls) {
      const field = fields.find(f => f && f.key === key);
      if (field && typeof field.when === 'function') {
        control.row.classList.toggle('hidden', !field.when(values));
      }
    }
  }
  form.addEventListener('input', refreshVisibility);
  form.addEventListener('change', refreshVisibility);
  refreshVisibility();

  let close = null;

  function submit() {
    for (const field of fields) {
      if (!field || !field.required) continue;
      const value = values[field.key];
      if (value == null || String(value).trim() === '') {
        toast(`${field.label} is required.`, 'error');
        const control = controls.get(field.key);
        if (control && control.focus) control.focus();
        return;
      }
    }
    const result = onSubmit(values);
    if (result === false) return;
    close();
  }

  close = modal({
    title,
    body: form,
    wide,
    actions: [
      ...extraActions.map(action => ({
        ...action,
        onClick: () => action.onClick(values, () => close()),
      })),
      { label: 'Cancel', onClick: () => close() },
      { label: confirmLabel, primary: true, onClick: submit },
    ],
  });

  // Focus the first real input so the dialog is keyboard-ready.
  const first = form.querySelector('input, textarea, select');
  if (first) setTimeout(() => first.focus(), 0);

  return { close: () => close(), values };
}

function defaultFor(field) {
  switch (field.type) {
    case 'checkbox': return false;
    case 'number': return null;
    case 'select': return field.options && field.options.length ? field.options[0].value : null;
    default: return '';
  }
}

function buildRow(field, values, controls) {
  const row = el('div', 'form-row');
  if (field.type !== 'checkbox') {
    const label = el('label', null, field.label);
    label.htmlFor = `field-${field.key}`;
    row.appendChild(label);
  }

  let control;
  const set = (value) => { values[field.key] = value; };

  switch (field.type) {
    case 'textarea': {
      control = el('textarea');
      control.rows = field.rows || 4;
      control.value = values[field.key] || '';
      control.addEventListener('input', () => set(control.value));
      break;
    }
    case 'number': {
      control = el('input');
      control.type = 'number';
      if (field.min != null) control.min = String(field.min);
      if (field.max != null) control.max = String(field.max);
      control.value = values[field.key] == null ? '' : String(values[field.key]);
      control.addEventListener('input', () => set(control.value === '' ? null : Number(control.value)));
      break;
    }
    case 'select': {
      control = el('select');
      for (const option of field.options || []) {
        const node = el('option', null, option.label);
        node.value = String(option.value);
        control.appendChild(node);
      }
      control.value = String(values[field.key] ?? '');
      control.addEventListener('change', () => {
        const chosen = (field.options || []).find(o => String(o.value) === control.value);
        set(chosen ? chosen.value : control.value);
      });
      break;
    }
    case 'checkbox': {
      control = el('input');
      control.type = 'checkbox';
      control.checked = !!values[field.key];
      control.addEventListener('change', () => set(control.checked));
      const wrap = el('label', 'form-check');
      wrap.appendChild(control);
      wrap.appendChild(el('span', null, field.label));
      row.appendChild(wrap);
      break;
    }
    case 'color': {
      control = el('input');
      control.type = 'color';
      control.value = values[field.key] || '#8a8f98';
      control.addEventListener('input', () => set(control.value));
      break;
    }
    case 'date': {
      control = dateField(field.calendar, values[field.key], set, field.allowEmpty);
      break;
    }
    case 'custom': {
      control = field.render(set, values[field.key]);
      break;
    }
    default: {
      control = el('input');
      control.type = 'text';
      control.value = values[field.key] || '';
      if (field.placeholder) control.placeholder = field.placeholder;
      control.addEventListener('input', () => set(control.value));
    }
  }

  if (control && field.type !== 'checkbox') {
    control.id = `field-${field.key}`;
    row.appendChild(control);
  }
  if (field.hint) row.appendChild(el('div', 'form-hint', field.hint));

  controls.set(field.key, { row, focus: () => control && control.focus && control.focus() });
  return row;
}

// ── Calendar-aware date input ────────────────────────────────────────────────

/** A date control that speaks whatever calendar the campaign uses: the month
 *  list, the day count and the leap rules all come from the Calendar. */
export function dateField(calendar, initial, onChange, allowEmpty = false) {
  const wrap = el('div', 'date-field');

  const parsed = calendar.parse(initial) || calendar.fromDay(0);
  let { y, m, d } = parsed;
  let empty = allowEmpty && !initial;

  const year = el('input', 'date-year');
  year.type = 'number';
  year.value = String(y);
  year.title = 'Year';

  const month = el('select', 'date-month');
  const day = el('select', 'date-day');

  function fillMonths() {
    clear(month);
    for (const option of calendar.monthOptions(y)) {
      const node = el('option', null, option.intercalary ? `${option.name} (festival)` : option.name);
      node.value = String(option.value);
      month.appendChild(node);
    }
    month.value = String(Math.min(m, calendar.months.length));
  }

  function fillDays() {
    const monthIndex = Number(month.value) - 1;
    const count = calendar.daysInMonth(y, monthIndex);
    clear(day);
    for (let i = 1; i <= count; i++) {
      const node = el('option', null, String(i));
      node.value = String(i);
      day.appendChild(node);
    }
    day.value = String(Math.min(d, count));
    day.disabled = count === 1;
  }

  function emit() {
    if (empty) { onChange(null); return; }
    y = Number(year.value) || 0;
    m = Number(month.value) || 1;
    d = Number(day.value) || 1;
    onChange(calendar.stringify(calendar.toDay({ y, m, d })));
  }

  year.addEventListener('input', () => {
    y = Number(year.value) || 0;
    const keptMonth = month.value;
    fillMonths();
    month.value = keptMonth;
    fillDays();
    emit();
  });
  month.addEventListener('change', () => { m = Number(month.value); fillDays(); emit(); });
  day.addEventListener('change', () => { d = Number(day.value); emit(); });

  fillMonths();
  fillDays();

  wrap.appendChild(day);
  wrap.appendChild(month);
  wrap.appendChild(year);

  if (allowEmpty) {
    const toggle = el('label', 'form-check date-open');
    const box = el('input');
    box.type = 'checkbox';
    box.checked = empty;
    box.addEventListener('change', () => {
      empty = box.checked;
      [year, month, day].forEach(node => { node.disabled = empty; });
      emit();
    });
    toggle.appendChild(box);
    toggle.appendChild(el('span', null, 'open-ended'));
    wrap.appendChild(toggle);
    [year, month, day].forEach(node => { node.disabled = empty; });
  }

  // Seed the initial value so a dialog submitted without edits still saves.
  if (!empty) onChange(calendar.stringify(calendar.toDay({ y, m, d })));

  return wrap;
}
