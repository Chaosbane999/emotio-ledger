// Calendar import: parsing, recurrence and time zones. Pure functions only —
// no network, and the tables it touches are not read here.
process.env.DATA_DIR = process.env.DATA_DIR || require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'ical-'));
const { _internal: I } = require('./calimport');
let n = 0; let bad = 0;
const ok = (c, msg) => { n += 1; if (!c) { bad += 1; console.error('  ✗', msg); } };
const ics = (body) => `BEGIN:VCALENDAR\r\n${body.trim().split('\n').map((l) => l.trim()).join('\r\n')}\r\nEND:VCALENDAR`;
const find = (list, date) => list.filter((m) => m.date === date);

const cal = ics(`
BEGIN:VEVENT
UID:one
SUMMARY:Arkay Windows catch up
DTSTART;TZID=GMT Standard Time:20261116T100000
DTEND;TZID=GMT Standard Time:20261116T110000
END:VEVENT
BEGIN:VEVENT
UID:utc
SUMMARY:Call in UTC
DTSTART:20260720T090000Z
DTEND:20260720T093000Z
END:VEVENT
BEGIN:VEVENT
UID:weekly
SUMMARY:Team huddle\\, weekly
DTSTART;TZID=GMT Standard Time:20261005T091500
DTEND;TZID=GMT Standard Time:20261005T093000
RRULE:FREQ=WEEKLY;BYDAY=MO,WE;INTERVAL=1
EXDATE;TZID=GMT Standard Time:20261111T091500
END:VEVENT
BEGIN:VEVENT
UID:weekly
RECURRENCE-ID;TZID=GMT Standard Time:20261118T091500
SUMMARY:Team huddle (moved)
DTSTART;TZID=GMT Standard Time:20261118T140000
DTEND;TZID=GMT Standard Time:20261118T143000
END:VEVENT
BEGIN:VEVENT
UID:allday
SUMMARY:Holiday
DTSTART;VALUE=DATE:20261117
DTEND;VALUE=DATE:20261118
END:VEVENT
BEGIN:VEVENT
UID:private
SUMMARY:Dentist
CLASS:PRIVATE
DTSTART;TZID=GMT Standard Time:20261117T100000
DTEND;TZID=GMT Standard Time:20261117T110000
END:VEVENT
BEGIN:VEVENT
UID:free
SUMMARY:Focus time
TRANSP:TRANSPARENT
DTSTART;TZID=GMT Standard Time:20261117T120000
DTEND;TZID=GMT Standard Time:20261117T130000
END:VEVENT
BEGIN:VEVENT
UID:monthly
SUMMARY:Board
DTSTART;TZID=GMT Standard Time:20260901T150000
DTEND;TZID=GMT Standard Time:20260901T160000
RRULE:FREQ=MONTHLY;BYDAY=3TU
END:VEVENT
BEGIN:VEVENT
UID:ny
SUMMARY:New York client
DTSTART;TZID=Eastern Standard Time:20261116T090000
DTEND;TZID=Eastern Standard Time:20261116T100000
END:VEVENT
BEGIN:VEVENT
UID:counted
SUMMARY:Three only
DTSTART;TZID=GMT Standard Time:20261109T160000
DTEND;TZID=GMT Standard Time:20261109T163000
RRULE:FREQ=DAILY;COUNT=3
END:VEVENT
`);
const m = I.meetingsFrom(cal, '2026-11-16');
const on = (d) => find(m, d).map((x) => `${x.start} ${x.title}`).sort();

ok(on('2026-11-16').includes('10:00 Arkay Windows catch up'), 'a plain meeting lands on its day and time');
ok(find(m, '2026-11-16').find((x) => x.title.startsWith('Arkay')).minutes === 60, 'its length is end minus start');
ok(on('2026-11-16').includes('09:15 Team huddle, weekly'), 'weekly recurrence expands (Monday)');
ok(!on('2026-11-11').some((t) => t.includes('huddle')), 'an EXDATE removes that occurrence');
ok(on('2026-11-09').includes('09:15 Team huddle, weekly'), 'the week before still has it');
ok(on('2026-11-18').join() === '14:00 Team huddle (moved)', 'a moved instance replaces the series occurrence');
ok(!m.some((x) => /Holiday|Dentist|Focus/.test(x.title)), 'all-day, private and free events are skipped');
ok(on('2026-11-17').includes('15:00 Board'), 'monthly by nth weekday (3rd Tuesday)');
ok(on('2026-11-16').includes('14:00 New York client'), 'another zone converts to London time');
ok(['2026-11-09', '2026-11-10', '2026-11-11'].every((d) => on(d).includes('16:00 Three only'))
  && !on('2026-11-12').some((t) => t.includes('Three')), 'COUNT stops the series');
ok(!m.some((x) => x.title === 'Call in UTC'), 'meetings outside the window are left out');
// summer time: a 09:00Z call is 10:00 in London in July
const summer = I.meetingsFrom(cal, '2026-07-21');
ok(find(summer, '2026-07-20').some((x) => x.start === '10:00' && x.title === 'Call in UTC'), 'UTC converts through British Summer Time');
// a weekly series keeps its clock time across the October clock change
ok(I.meetingsFrom(cal, '2026-10-20').filter((x) => x.title.startsWith('Team huddle')).every((x) => x.start === '09:15'),
  'recurrences keep their clock time across the clock change');

const cs = [{ id: 1, name: 'Arkay Windows' }, { id: 2, name: 'Quantum Windows' }, { id: 3, name: 'NLG' },
  { id: 4, name: 'Chase Buchanan Website' }, { id: 5, name: 'Emotio — internal' }];
ok(I.guessContract('Arkay Windows catch up', cs) === 1, 'full contract name in the title');
ok(I.guessContract('Weekly call - Arkay', cs) === 1, 'distinctive first word');
ok(I.guessContract('NLG: budgets', cs) === 3, 'short names match whole');
ok(I.guessContract('Chase Buchanan kick-off', cs) === 4, 'first word of a longer name');
ok(I.guessContract('Lunch with Sam', cs) === null, 'no match means no guess');

let threw = 0;
for (const u of ['http://outlook.office365.com/x.ics', 'https://evil.example.com/cal.ics', 'https://localhost/x', 'not a url']) {
  try { I.checkUrl(u); } catch (e) { threw += 1; }
}
ok(threw === 4, 'only https links on known calendar hosts are accepted');
ok(I.checkUrl('webcal://outlook.office365.com/owa/calendar/a/b/calendar.ics').startsWith('https://outlook.office365.com/'), 'webcal links are accepted as https');

console.log(`${n} calendar checks run`);
if (bad) { console.error(`${bad} FAILED`); process.exit(1); }
console.log('calendar import holds');
