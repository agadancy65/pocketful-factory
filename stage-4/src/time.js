'use strict';

function pad(value) {
  return String(value).padStart(2, '0');
}

// RFC 3339 with an explicit numeric offset, e.g. 2026-09-24T19:00:00+02:00
function format(date) {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes < 0 ? '-' : '+';
  const abs = Math.abs(offsetMinutes);
  const datePart = date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
  const timePart = pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
  const offset = sign + pad(Math.floor(abs / 60)) + ':' + pad(abs % 60);
  return datePart + 'T' + timePart + offset;
}

// The same instant with millisecond precision. Server-assigned recorded times
// use this so that two revisions of one payment can strictly increase even when
// they are applied inside the same wall-clock second.
function formatMillis(date) {
  const base = format(date);
  const at = base.length - 6;
  return base.slice(0, at) + '.' + String(date.getMilliseconds()).padStart(3, '0') + base.slice(at);
}

function now() {
  return format(new Date());
}

function nowMillis() {
  return formatMillis(new Date());
}

function secondsAgo(seconds) {
  return format(new Date(Date.now() - seconds * 1000));
}

// An RFC 3339 instant carrying an explicit offset. A naive local time, a bare
// date or an empty string is not an instant and parses to null.
const INSTANT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

function parseInstant(text) {
  if (typeof text !== 'string') return null;
  const match = INSTANT_PATTERN.exec(text);
  if (!match) return null;
  const offset = match[8];
  if (offset !== 'Z' && offset !== 'z') {
    if (Number(offset.slice(1, 3)) > 23 || Number(offset.slice(4, 6)) > 59) return null;
  }
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59 || second > 60) return null;
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : parsed;
}

module.exports = { format, formatMillis, now, nowMillis, secondsAgo, parseInstant };