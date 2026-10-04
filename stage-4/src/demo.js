'use strict';

// The demo accounts a stage 4 service seeds for itself when it starts with no
// state. Balances are minor units, so 10000 is 100.00 EUR. Every account shares
// one password, so the login and signup screens can advertise the same set.
const DEMO_PASSWORD = 'correct horse';

const DEMO_USERS = [
  { id: 'u_ada', email: 'ada@example.com', display_name: 'Ada', handle: 'ada', balance: 10000 },
  { id: 'u_bob', email: 'bob@example.com', display_name: 'Bob', handle: 'bob', balance: 25000 },
  { id: 'u_joseph', email: 'joseph@example.com', display_name: 'Joseph', handle: 'joseph', balance: 50000 },
  { id: 'u_agada', email: 'agada@example.com', display_name: 'Agada', handle: 'agada', balance: 7500 },
  { id: 'u_john', email: 'john@example.com', display_name: 'John', handle: 'john', balance: 3000 },
];

// The same transaction shape POST /_test/reset accepts, so the seed is built by
// stateFromFixture and keeps every invariant a reset has (revision 1, opening
// balances, hashed passwords).
function demoFixture() {
  return {
    currency: 'EUR',
    minor_units: 2,
    users: DEMO_USERS.map((user) => Object.assign({ password: DEMO_PASSWORD }, user)),
  };
}

module.exports = { DEMO_PASSWORD, DEMO_USERS, demoFixture };