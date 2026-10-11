// Why: review thread resolution status + thread IDs are GraphQL-only (REST pulls/{n}/comments omits them).
// And why `reviews(last:)`: a 100-review cap has to keep the most recent submissions, or a
// long-running PR's latest decision is the entry that gets cut off and the panel's verdict block
// contradicts `reviewDecision`. Node order is chronological either way.
export const REVIEW_THREADS_QUERY = `
query($owner: String!, $repo: String!, $pr: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $pr) {
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          line
          startLine
          originalLine
          originalStartLine
          comments(first: 100) {
            nodes {
              id
              databaseId
              author { __typename login avatarUrl(size: 48) }
              body
              createdAt
              url
              path
              reactionGroups {
                content
                viewerHasReacted
                reactors {
                  totalCount
                }
              }
            }
          }
        }
      }
      comments(first: 100) {
        nodes {
          id
          databaseId
          author { __typename login avatarUrl(size: 48) }
          body
          createdAt
          url
          reactionGroups {
            content
            viewerHasReacted
            reactors {
              totalCount
            }
          }
        }
      }
      reviews(last: 100) {
        nodes {
          id
          databaseId
          author { __typename login avatarUrl(size: 48) }
          body
          state
          createdAt
          url
          reactionGroups {
            content
            viewerHasReacted
            reactors {
              totalCount
            }
          }
        }
      }
    }
  }
}`
