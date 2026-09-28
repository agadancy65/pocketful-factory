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

function now() {
  return format(new Date());
}

function secondsAgo(seconds) {
  return format(new Date(Date.now() - seconds * 1000));
}

module.exports = { format, now, secondsAgo };