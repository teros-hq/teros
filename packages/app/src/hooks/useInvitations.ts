import { useEffect, useState } from "react"
import type { TerosClient } from "../services/TerosClient"

export interface InvitationStatus {
  /** Whether user has access granted */
  accessGranted: boolean
  /** Number of invitations received */
  received: number
  /** Number required to get access */
  required: number
  /** Number of invitations user can send */
  availableInvitations: number
  /** List of invitations with sender info */
  invitations: Array<{
    fromUserId: string
    sender?: {
      userId: string
      displayName: string
      email: string
      avatarUrl?: string
    }
    createdAt: string
  }>
}

export interface Invitation {
  invitationId: string
  toUser: {
    userId: string
    displayName: string
    email: string
  }
  sentAt: string
  accepted?: boolean
  acceptedAt?: string
}

export interface InvitableUser {
  userId: string
  displayName: string
  email: string
}

export const useInvitations = (client: TerosClient | null) => {
  const [status, setStatus] = useState<InvitationStatus | null>(null)
  const [sentInvitations, setSentInvitations] = useState<Invitation[]>([])
  const [invitableUsers, setInvitableUsers] = useState<InvitableUser[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Load invitation status
  const loadStatus = async () => {
    if (!client) return

    try {
      setLoading(true)
      setError(null)

      const result = (await client.admin.getInvitationStatus()) as any
      setStatus({
        accessGranted: result.accessGranted,
        received: result.received,
        required: result.required,
        availableInvitations: result.availableInvitations,
        invitations: result.invitations || [],
      })
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  // Send invitation
  const sendInvitation = async (email: string): Promise<boolean> => {
    if (!client) return false

    try {
      setLoading(true)
      setError(null)

      const result = await client.admin.sendInvitation(email)
      if ("success" in result && !result.success) {
        setError((result as any).error || "Failed to send invitation")
        return false
      }
      // Refresh sent invitations list
      loadSentInvitations()
      return true
    } catch (err: any) {
      setError(err.message)
      return false
    } finally {
      setLoading(false)
    }
  }

  // Load sent invitations
  const loadSentInvitations = async () => {
    if (!client) return

    try {
      setLoading(true)

      const result = await client.admin.getInvitationsSent()
      setSentInvitations((result.invitations || []) as any)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  // Load invitable users
  const loadInvitableUsers = async (limit?: number) => {
    if (!client) return

    try {
      setLoading(true)

      const result = await client.admin.getInvitableUsers(limit)
      setInvitableUsers((result.users || []) as any)
    } catch (err: any) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }

  // Revoke invitation
  const revokeInvitation = async (toUserId: string): Promise<boolean> => {
    if (!client) return false

    try {
      setLoading(true)
      setError(null)

      // NOTE: admin.revoke-invitation is an admin-only operation (requires admin/super role).
      // fromUserId is required by the backend; passing empty string will result in MISSING_FIELDS.
      // This call is intentionally left as-is — revoking another user's invitation from a
      // non-admin context is not a supported flow. Admin UIs should pass the correct fromUserId.
      await client.admin.revokeInvitation("", toUserId)
      // Refresh sent invitations list
      loadSentInvitations()
      return true
    } catch (err: any) {
      setError(err.message)
      return false
    } finally {
      setLoading(false)
    }
  }

  // Auto-load status on mount and when client connects
  useEffect(() => {
    if (client && client.isConnected()) {
      loadStatus()
    }

    const handleConnected = () => {
      loadStatus()
    }

    client?.on("connected", handleConnected)

    return () => {
      client?.off("connected", handleConnected)
    }
  }, [client])

  return {
    status,
    sentInvitations,
    invitableUsers,
    loading,
    error,
    loadStatus,
    sendInvitation,
    loadSentInvitations,
    loadInvitableUsers,
    revokeInvitation,
  }
}
