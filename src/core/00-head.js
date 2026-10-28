// SPDX-License-Identifier: AGPL-3.0-only
// The file comment and the opening of the function the parts run in. The build joins the src/core/ parts in name order inside one function, so they share one scope.

// The workbench's pure logic: formatting, parsing, and export generation.
// Nothing here touches the DOM, storage, or the network, so the same file runs
// in the page (as window.SaltCore) and under Node's test runner (tests/js/).

(function (root) {
'use strict';
