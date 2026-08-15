/* The left rail: the campaign clock.
 *
 * Dragging it changes the date, and the date changes who is standing where —
 * that link is the whole point of the app, so the clock is never hidden.
 */

import { $, el, clear, toast, formDialog } from './ui.js';
import { S, setDay, eventsNear, nextMark, group, on, emit } from './store.js';

export function wireClock() {
  $('clock-slider').addEventListener('input', (event) => {
    setDay(Number(event.target.value));
  });

  $('clock-prev').addEventListener('click', () => setDay(S.currentDay - 1));
  $('clock-next').addEventListener('click', () => setDay(S.currentDay + 1));
  $('clock-today').addEventListener('click', jumpToParty);
  $('clock-date').addEventListener('click', openJumpDialog);

  on('render', renderClock);
}

/** "Now" means the last thing the party actually did, falling back to the date
 *  the campaign declares as its present. */
function jumpToParty() {
  const partyDays = S.world.events
    .filter(event => event.track === 'party')
    .map(event => S.cal.dayOf(event.date))
    .filter(day => day != null);

  if (partyDays.length) {
    setDay(Math.max(...partyDays));
    toast('Jumped to the latest session.');
  } else {
    setDay(S.cal.dayOf(S.campaign.clock.current));
  }
}

function openJumpDialog() {
  let picked = S.cal.stringify(S.currentDay);
  formDialog({
    title: 'Jump to a date',
    confirmLabel: 'Go',
    fields: [
      { key: 'date', label: 'Date', type: 'date', calendar: S.cal, value: picked },
    ],
    onSubmit: (values) => {
      const day = S.cal.dayOf(values.date);
      if (day == null) return false;
      setDay(day);
    },
  });
}

export function renderClock() {
  const slider = $('clock-slider');
  const startDay = S.cal.dayOf(S.campaign.clock.start);
  const endDay = S.cal.dayOf(S.campaign.clock.end);

  slider.min = String(startDay);
  slider.max = String(endDay);
  slider.value = String(S.currentDay);

  $('clock-date').textContent = S.cal.format(S.currentDay, 'long');

  const weekday = S.cal.weekdayOf(S.currentDay);
  $('clock-weekday').textContent = weekday || '';

  renderCountdown();
  renderMarks(startDay, endDay);
  renderEvents();
  renderLegend();
}

function renderCountdown() {
  const node = $('clock-doom');
  const next = nextMark(S.currentDay);
  if (!next) {
    node.textContent = '';
    node.style.color = '';
    return;
  }

  const gap = next.day - S.currentDay;
  const label = next.mark.label || 'the deadline';
  if (gap === 0) node.textContent = `${label} — today`;
  else if (gap > 0) node.textContent = `${S.cal.describeGap(gap)} until ${label}`;
  else node.textContent = `${S.cal.describeGap(gap)} since ${label}`;

  node.style.color = next.mark.color || '';
}

/** Ticks under the slider, so a deadline is visible before you scrub onto it. */
function renderMarks(startDay, endDay) {
  const track = clear($('clock-marks'));
  const span = Math.max(endDay - startDay, 1);

  for (const mark of S.campaign.clock.marks || []) {
    const day = S.cal.dayOf(mark.date);
    if (day == null || day < startDay || day > endDay) continue;
    const tick = el('span', 'clock-mark');
    tick.style.left = ((day - startDay) / span) * 100 + '%';
    tick.style.background = mark.color || '#c0392b';
    tick.title = `${mark.label} — ${S.cal.format(day, 'long')}`;
    tick.addEventListener('click', () => setDay(day));
    track.appendChild(tick);
  }
}

function renderEvents() {
  const list = clear($('clock-events'));
  const near = eventsNear(S.currentDay);

  if (!near.length) {
    list.appendChild(el('div', 'lane-empty', 'Nothing within three weeks.'));
    return;
  }

  for (const { event, day } of near.slice(0, 30)) {
    const item = el('div', `lane-item ${event.track || 'world'}`);
    const gap = day - S.currentDay;
    const when = gap === 0 ? 'Today'
      : gap < 0 ? `${S.cal.describeGap(gap)} ago`
        : `in ${S.cal.describeGap(gap)}`;

    item.appendChild(el('span', 'when', when));
    item.appendChild(document.createTextNode(event.text));
    item.title = `${S.cal.format(day, 'long')}${event.detail ? ' — ' + event.detail : ''}`;
    item.addEventListener('click', () => emit('open-event', event.id));
    list.appendChild(item);
  }
}

function renderLegend() {
  const box = clear($('clock-legend'));
  for (const g of S.campaign.groups) {
    if (g.hidden) continue;
    const row = el('div', 'legend-row');
    const dot = el('span', 'legend-dot');
    dot.style.background = g.color;
    row.appendChild(dot);
    row.appendChild(el('span', null, g.name));
    row.title = g.summary || g.name;
    box.appendChild(row);
  }
  if (!box.childElementCount) {
    box.appendChild(el('div', 'lane-empty', 'No groups yet.'));
  }
}

export { group };
