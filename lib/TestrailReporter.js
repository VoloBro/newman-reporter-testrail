const request = require('sync-request');

class TestRailReporter {
  constructor(emitter, reporterOptions, options) {
    const results = [];
    const testAsserts = [];
    let responseObj = null;
    let requestObj = null;
    let exceptionString = null;

    emitter.on('exception', (err, args) => {
      exceptionString = JSON.stringify(args.error);
    })

    emitter.on('beforeDone', (err, args) => {
      if (results.length > 0) {
        const domain = process.env.TESTRAIL_DOMAIN;
        const username = process.env.TESTRAIL_USERNAME;
        const apikey = process.env.TESTRAIL_APIKEY;
        const projectId = process.env.TESTRAIL_PROJECTID;
        const suiteId = process.env.TESTRAIL_SUITEID;
        const type = process.env.TESTRAIL_TYPE;
        const closeRun = (process.env.TESTRAIL_CLOSE_RUN === 'true');
        const envRunId = process.env.TESTRAIL_RUNID;
        const customFields = process.env.TESTRAIL_CUSTOM;
        // const debugRequests = (process.env.DEBUG_REQUEST === 'true');

        const auth = Buffer.from(`${username}:${apikey}`).toString('base64');

        const path = (suiteId) ? `get_suite/${suiteId}` : `get_project/${projectId}`;
        let response = request('GET', `https://${domain}/index.php?/api/v2/${path}`, {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Basic ${auth}`,
          },
        });
        if (response.statusCode >= 300) console.error(response.getBody());
        const title = process.env.TESTRAIL_TITLE || `${JSON.parse(response.getBody()).name}: Automated Test Run`;

        let results_filtered = results;

        let runId = envRunId;
        if (!runId) {
          // Get all test cases from the project, filtering by suite if defined
          const get_cases_base = `https://${domain}/index.php?/api/v2/get_cases/${projectId}`;
          const get_cases_path = (suiteId) ? `${get_cases_base}&suite_id=${suiteId}` : get_cases_base;
          response = request('GET', get_cases_path, {
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Basic ${auth}`,
            }
          });
          if (response.statusCode >= 300) console.error(response.getBody());
          var cases = JSON.parse(response.getBody());

          // Get available case types        
          response = request('GET', `https://${domain}/index.php?/api/v2/get_case_types`, {
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Basic ${auth}`,
            }
          });
          if (response.statusCode >= 300) console.error(response.getBody());
          var caseTypes = JSON.parse(response.getBody());

          // Find the case type ID by name and filter the test cases
          if (type) {
            var caseType;
            if (caseTypes.length > 0) {
              caseType = caseTypes.filter(ct => ct.name == `${type}`);
              if (caseType.length > 0) {
                cases = cases.filter(tc => tc.type_id == caseType[0].id);
              }
            }
          }

          if (customFields) {
            const key = customFields.split(":")[0].trim();
            const value = customFields.split(":")[1].trim();
            cases = cases.filter(tc => tc[key] == value);
          }

          var caseIds = cases.map(c => c.id);

          var addRunPayload = {};
          if (caseIds.length > 0) {
            addRunPayload = {
              name: title,
              suite_id: suiteId,
              include_all: false,
              case_ids: caseIds
            }
          } else {
            // Include all test cases into the test run if our filter returned zero results
            addRunPayload = {
              name: title,
              suite_id: suiteId
            }
          }

          response = request('POST', `https://${domain}/index.php?/api/v2/add_run/${projectId}`, {
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Basic ${auth}`,
            },
            json: addRunPayload,
          });
          if (response.statusCode >= 300) console.error(response.getBody());
          runId = JSON.parse(response.getBody()).id;
        }

        // Get all test cases from the run
        const get_tests = `https://${domain}/index.php?/api/v2/get_tests/${runId}`;
        response = request('GET', get_tests, {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Basic ${auth}`,
          }
        });

        if (response.statusCode >= 300) console.error(response.getBody());
        var cases = JSON.parse(response.getBody());

        var ids = cases.map(a => `${a.case_id}`);
        // var res_ids = results.map(a => a.case_id);

        results_filtered = results.filter(res => ids.includes(res.case_id));

        if (results.length > results_filtered.length) {
          console.log(`Posting results only for test cases present in run. Executed: ${results.length}, Available: ${results_filtered.length}`);
          console.log(`Tests not in run ${runId}`, results.filter(res => !ids.includes(res.case_id)));
        }

        response = request('POST', `https://${domain}/index.php?/api/v2/add_results_for_cases/${runId}`, {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Basic ${auth}`,
          },
          json: {
            "results": results_filtered
          },
        });
        if (response.statusCode >= 300) console.error(response.getBody());

        console.log(`\nhttps://${domain}/index.php?/runs/view/${runId}`);

        const runHasFailedCases = results_filtered.filter(item => item.status_id === 5).length > 0;
        console.log("Run has failed cases: ", runHasFailedCases);
        if (runHasFailedCases) {
          process.env.TESTRAIL_RUN_FAILED = "true";
        }

        if (closeRun) {
          console.log("Closing the run");
          response = request('POST', `https://${domain}/index.php?/api/v2/close_run/${runId}`, {
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Basic ${auth}`,
            }
          });
          if (response.statusCode >= 300) console.error(response.getBody());
        }
        else {
          console.log("Leaving the test run open.");
        }
      } else {
        console.error('\nnewman-reporter-testrail: No test cases were found.');
      }
    });
    emitter.on('item', (err, args) => {
      // Split and match instead of a regex with /g to match only
      // leading cases and not ones referenced later in the assertion
      const strings = args.item.name.split(' /| /');
      const testCaseRegex = /\bC(\d+)\b/;
      for (let i = 0; i < strings.length; i++) {
        const matches = strings[i].match(testCaseRegex);
        if (matches) {
          const itemCaseID = matches[1];

          const lastResultTemp = {
            case_id: itemCaseID,
            status_id: 1, //1 - passed, 5 - failed
            comment: ""
          };

          const matchingResultIndex = results.findIndex(prevResult => prevResult.case_id === itemCaseID);
          const lastResult = matchingResultIndex > -1 ? results[matchingResultIndex] : lastResultTemp;

          const assertsFormatted = [];
          testAsserts.forEach(assert => {
            if (assert.error) {
              lastResult.status_id = 5
            }

            assertsFormatted.push(`ASSERT [${assert.error ? "FAILED" : "PASSED"}]: ${assert.name}${assert.error ? `, error: ${assert.error}` : ""}`);
          });

          const reqBodyF = requestObj.body ? requestObj.body.raw : "";

          const lineBreak = "------------------";
          const testName = `**Request name:** ${args.item.name}`;
          lastResult.comment += `${testName}\n${lineBreak}\n`;

          if (responseObj) {
            const resBodyF = responseObj.stream.toString();

            const urlMsg = `${requestObj.method} [${responseObj.code} ${responseObj.status}, ${responseObj.responseTime / 1000}s] ${requestObj.url}`;
            const reqBody = `**Request body:** \n    ${reqBodyF}`;
            const respMsg = `**Response body:** \n    ${resBodyF}`;

            lastResult.comment += `${assertsFormatted.join("\n")}\n${urlMsg}\n${reqBody}\n${respMsg}}\n\n`;
          }

          if (exceptionString) {
            lastResult.status_id = 5;
            lastResult.comment += `**Script exception:** \n> ${exceptionString}`;
            exceptionString = "";
          }

          if (matchingResultIndex > -1) {
            results[matchingResultIndex] = lastResult;
          } else {
            results.push(lastResult);
          }
          testAsserts.length = 0;
        }
      }
    });
    emitter.on('request', (err, args) => {
      responseObj = args.response;
      requestObj = args.request;
    });
    emitter.on('assertion', (err, args) => {
      const assert = { name: args.assertion, error: err ? err.message : null }
      testAsserts.push(assert);
    });
  }
}

module.exports = TestRailReporter;
