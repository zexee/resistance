# README #

This is for board game Resistance.

https://en.wikipedia.org/wiki/The_Resistance_(game)

# INSTALL #
npm install

# RUN #
npm start

default port is 18181, override with PORT

# TEST #
npm test
npm run test:ui

`npm test` runs the socket integration test. `npm run test:ui` runs the Chrome/Puppeteer UI test (`CHROME_PATH` overrides the default Chrome path). Both spawn their own server on a random port.
