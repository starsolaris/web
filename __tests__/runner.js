const assert = require('assert');
const util = require('util');
const path = require('path');
const fs = require('fs').promises;
const {readdirSync, readFileSync} = require('fs');
const execa = require('execa');
const dircompare = require('dir-compare');

for (const testName of readdirSync(__dirname)) {
  if (testName === 'node_modules' || testName.includes('.')) {
    continue;
  }

  test(testName, async () => {
    const {all} = await execa('npm', ['run', `TEST`, `--silent`], {
      cwd: path.join(__dirname, testName),
      reject: false,
    });
    // Test Output
    const expectedOutputLoc = path.join(__dirname, testName, 'expected-output.txt');
    const expectedOutput = await fs.readFile(expectedOutputLoc, {encoding: 'utf8'});
    assert.strictEqual(all, expectedOutput);

    const expectedWebDependenciesLoc = path.join(__dirname, testName, 'expected-install');
    const actualWebDependenciesLoc = path.join(__dirname, testName, 'web_modules');
    const expectedWebDependencies = await fs.readdir(expectedWebDependenciesLoc).catch(() => {});
    if (!expectedWebDependencies) {
      assert.rejects(() => fs.readdir(actualWebDependenciesLoc), 'web_modules/ exists');
      return;
    }

    // Test That all expected files are there
    const actualWebDependencies = await fs.readdir(actualWebDependenciesLoc);
    assert.deepEqual(actualWebDependencies, expectedWebDependencies);

    // Test That all files match
    var res = dircompare.compareSync(actualWebDependenciesLoc, expectedWebDependenciesLoc, {
      compareSize: true,
    });
    // If any diffs are detected, we'll assert the difference so that we get nice output.
    res.diffSet.forEach(function(entry) {
      assert.strictEqual(
        readFileSync(path.join(entry.path1, entry.name1), {encoding: 'utf8'}),
        readFileSync(path.join(entry.path2, entry.name2), {encoding: 'utf8'}),
      );
    });
  });
}
