/**
 * A syntactically valid but FAKE Slack incoming-webhook URL, assembled from parts so that no secret scanner mistakes a
 * test fixture for a leaked credential. It points nowhere: every test sends through an injected fake client.
 */
export const FAKE_SLACK_URL = ["https://hooks.slack.com", "services", "T0123ABCD", "B0123ABCD", "abcdEFGHijklMNOPqrstUVWX"].join("/");
