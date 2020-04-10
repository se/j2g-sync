"use strict";

const jira = require("jira-connector");
const rp = require("request-promise");
var AWS = require("aws-sdk");
AWS.config.update({
  region: process.env.AWSX_REGION,
  accessKeyId: process.env.AWSX_ACCESS_KEYID,
  secretAccessKey: process.env.AWSX_SECRET_KEY,
});
var dc = new AWS.DynamoDB.DocumentClient();

const Gitlab = require("gitlab/dist/es5").default;
const api = new Gitlab({
  token: process.env.GITLAB_TOKEN,
});
const needApprovement = 2;
const regex = /MSIGN-\d+/gm;
const Transitions = {
  InProgress: "190",
  WaitingForPublish: "70",
  SendToReview: "80",
};
const JIRA_HOST = process.env.JIRA_HOST;
const JIRA_USER = process.env.JIRA_USER;
const JIRA_PASSWORD = process.env.JIRA_PASSWORD;

const GITLAB_TOKEN_HEADER = "X-Gitlab-Token";
const GITLAB_TOKEN_VALUE = process.env.GITLAB_TOKEN_VALUE;

const J2G_TOKEN_HEADER = "X-J2G-Token";
const J2G_TOKEN_VALUE = process.env.J2G_TOKEN_VALUE;

function success(message, data) {
  const rv = data
    ? {
        statusCode: 200,
        message,
        body: JSON.stringify({
          data,
          message,
        }),
      }
    : {
        statusCode: 200,
        body: JSON.stringify({
          message,
        }),
      };
  return rv;
}

function error(message, code, data) {
  if (!code) {
    code = 400;
  }
  return data
    ? {
        statusCode: code,
        message,
        body: JSON.stringify(data),
      }
    : {
        statusCode: code,
      };
}

function data(message, data, code) {}

function getBranchName(str) {
  const m = regex.exec(str);
  if (m !== null && m.length > 0) {
    const b = m[0];
    if (b !== null && b.trim().length > 0) {
      return b.trim();
    }
  }
  return null;
}

function getClient() {
  return new jira({
    host: JIRA_HOST,
    basic_auth: {
      username: JIRA_USER,
      password: JIRA_PASSWORD,
    },
  });
}

async function transitionToInProgress(value) {
  let branchName = getBranchName(value.ref);
  if (!branchName) {
    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "No action.",
      }),
    };
  }

  if (value.before !== "0000000000000000000000000000000000000000") {
    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "No need to take action",
      }),
    };
  }

  let rv = {};

  const client = getClient();

  let issue = await client.issue.getIssue({
    issueKey: branchName,
  });

  if (!issue) {
    return {
      statusCode: 404,
      body: JSON.stringify({
        message: "Issue not found on jira.",
      }),
    };
  }

  let users = await client.user.search({
    username: value.user_name,
  });

  if (users && users.length === 1) {
    const user = users[0];
    try {
      await client.issue.assignIssue({
        issueKey: branchName,
        assignee: user.key,
      });
    } catch (error) {
      console.error("Assignment error.");
      console.error(error);
    }
  }

  rv.status = {
    before: {
      id: parseInt(issue.fields.status.id),
      name: issue.fields.status.name,
    },
    next: {
      id: Transitions.InProgress,
      name: "In Progress",
    },
  };

  if (rv.status.before.id !== 1) {
    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "Transition branch...",
        data: rv,
      }),
    };
  }

  try {
    await client.issue.transitionIssue({
      issueKey: branchName,
      transition: Transitions.InProgress,
    });

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "Transition completed.",
        data: rv,
      }),
    };
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        message: "Something went wrong...",
        exception: error,
      }),
    };
  }
}

async function transitionToWaitingForPublish(value) {
  const state = value.object_attributes.state;

  if (state !== "merged") {
    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "No need to take action",
      }),
    };
  }

  const branch = getBranchName(value.object_attributes.source_branch);

  if (!branch) {
    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "No action.",
      }),
    };
  }

  let rv = {};
  const client = getClient();

  let issue = await client.issue.getIssue({
    issueKey: branch,
  });

  if (!issue) {
    return {
      statusCode: 404,
      body: JSON.stringify({
        message: "Issue not found on jira.",
      }),
    };
  }

  rv.status = {
    before: {
      id: parseInt(issue.fields.status.id),
      name: issue.fields.status.name,
    },
    next: {
      id: 0,
      name: null,
    },
  };

  if (rv.status.before.id !== 3 || rv.status.before.name !== "In Progress") {
    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "No need to transition",
        issue,
      }),
    };
  }

  try {
    await client.issue.transitionIssue({
      issueKey: issue.key,
      transition: Transitions.WaitingForPublish,
    });

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "Transited to Waiting for Publish.",
      }),
    };
  } catch (error) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        message: "Something went wrong...",
        exception: error,
      }),
    };
  }
}

async function mergeRequestActions(value) {
  const action = value.object_attributes.action;

  if (action === "approved" || action === "unapproved") {
    // if (value.object_attributes.work_in_progress) {
    // 	return error("This branch is currently work in progress.");
    // }

    try {
      const approvement = action === "approved";
      const current = await dc
        .get({
          TableName: "GITLAB_APPROVEMENTS",
          Key: {
            PROJECT_ID: parseInt(value.project.id),
            MR_ID: parseInt(value.object_attributes.iid),
          },
        })
        .promise();

      let count = 0;
      let users = [];
      if (current && current.Item) {
        if (current.Item.COUNT) {
          count = current.Item.COUNT;
        }
        if (current.Item.USERS) {
          users = current.Item.USERS;
        }
      }

      const already = users.find((x) => x.username == value.user.username);
      if (approvement && !already) {
        users.push(value.user);
        count++;
      } else if (!approvement && already) {
        users = users.filter((x) => x.username !== value.user.username);
        count--;
      }

      await dc
        .put({
          TableName: "GITLAB_APPROVEMENTS",
          Item: {
            PROJECT_ID: parseInt(value.project.id),
            MR_ID: parseInt(value.object_attributes.iid),
            COUNT: count,
            USERS: users,
          },
        })
        .promise();

      if (count >= needApprovement) {
        const result = await api.MergeRequests.accept(
          `${value.project.id}`,
          `${value.object_attributes.iid}`
        );
        console.log(result);

        return success(
          `I have ${count} approved users for this MR. I have merged it to target branch.`
        );
      }

      return success(
        `[${count}/${needApprovement}] user approved this MR. We have need ${
          needApprovement - count
        } more too.`
      );
    } catch (err) {
      console.error(err);
      return error("There is something wrong with this request.");
    }
  }
  return transitionToWaitingForPublish(value);
}

module.exports.gitlab = async (event, context) => {
  const token = event.headers[GITLAB_TOKEN_HEADER];
  if (!token || token !== GITLAB_TOKEN_VALUE) {
    return error("Unauthorized", 401);
  }

  let value = JSON.parse(event.body);

  try {
    if (value) {
      switch (value.object_kind) {
        case "push":
          return transitionToInProgress(value);
        case "merge_request":
          return mergeRequestActions(value);
        default:
          break;
      }
    }

    return {
      statusCode: 400,
      body: JSON.stringify({
        message: "Invalid action.",
      }),
    };
  } catch (error) {
    console.error(error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        message: "Error.",
      }),
    };
  }
};

module.exports.jenkins = async (event, context) => {
  const token = event.headers[J2G_TOKEN_HEADER];
  if (!token || token !== J2G_TOKEN_VALUE) {
    return {
      statusCode: 401,
      body: JSON.stringify({
        message: "Unauthorized.",
      }),
    };
  }

  const value = JSON.parse(event.body);

  if (!value || (!value.mergecommit && !value.commits.length)) {
    return {
      statusCode: 204,
      body: JSON.stringify({
        message: "There is no action to take.",
      }),
    };
  }

  let count = 0;
  let issues = [];
  if (value.mergecommit) {
    let matches = regex.exec(value.mergecommit);
    matches &&
      matches.forEach((v) => {
        if (issues.indexOf(v) === -1) {
          count++;
          issues.push(v);
        }
      });
  }

  value.commits &&
    value.commits.forEach((commit) => {
      let matches = regex.exec(commit);
      matches &&
        matches.forEach((v) => {
          if (issues.indexOf(v) === -1) {
            count++;
            issues.push(v);
          }
        });
    });

  if (count === 0) {
    return {
      statusCode: 200,
      body: JSON.stringify({
        message:
          "No need to trigger JIRA. Because no issue found in commit messages or merge commits.",
      }),
    };
  }

  const client = getClient();
  let errors = [];
  for (let index = 0; index < issues.length; index++) {
    const key = issues[index];
    try {
      await client.issue.transitionIssue({
        issueKey: key,
        transition: Transitions.SendToReview,
      });
    } catch (error) {
      errors.push({
        key: "Transition error",
      });
      console.error(error);
    }
  }

  return {
    statusCode: 200,
    body: JSON.stringify({
      message: "Issues are transited.",
      issues,
      errors,
    }),
  };
};
