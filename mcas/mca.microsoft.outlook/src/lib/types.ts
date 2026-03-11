export interface OutlookSecrets {
  CLIENT_ID?: string
  CLIENT_SECRET?: string
  REDIRECT_URIS?: string
  ACCESS_TOKEN?: string
  REFRESH_TOKEN?: string
  EMAIL?: string
  EXPIRY_DATE?: string
}

export interface GraphError {
  error?: {
    code?: string
    message?: string
  }
}
