export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.15"
  }
  public: {
    Tables: {
      activity_log: {
        Row: {
          created_at: string
          id: string
          kind: string
          metadata: Json
          summary: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          kind: string
          metadata?: Json
          summary: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          kind?: string
          metadata?: Json
          summary?: string
          user_id?: string
        }
        Relationships: []
      }
      agent_connections: {
        Row: {
          api_key: string | null
          base_url: string | null
          created_at: string
          id: string
          is_active: boolean
          label: string
          metadata: Json
          mode: string
          readiness_status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          api_key?: string | null
          base_url?: string | null
          created_at?: string
          id?: string
          is_active?: boolean
          label: string
          metadata?: Json
          mode?: string
          readiness_status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          api_key?: string | null
          base_url?: string | null
          created_at?: string
          id?: string
          is_active?: boolean
          label?: string
          metadata?: Json
          mode?: string
          readiness_status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      credential_records: {
        Row: {
          agent_id: string | null
          bundle_id: string | null
          claims: Json
          created_at: string
          credential_jwt: string | null
          id: string
          invitation_url: string | null
          issuer_did: string | null
          record_id: string | null
          simulated: boolean
          state: string
          subject_did: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          agent_id?: string | null
          bundle_id?: string | null
          claims?: Json
          created_at?: string
          credential_jwt?: string | null
          id?: string
          invitation_url?: string | null
          issuer_did?: string | null
          record_id?: string | null
          simulated?: boolean
          state?: string
          subject_did?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          agent_id?: string | null
          bundle_id?: string | null
          claims?: Json
          created_at?: string
          credential_jwt?: string | null
          id?: string
          invitation_url?: string | null
          issuer_did?: string | null
          record_id?: string | null
          simulated?: boolean
          state?: string
          subject_did?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "credential_records_agent_id_fkey"
            columns: ["agent_id"]
            isOneToOne: false
            referencedRelation: "agent_connections"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "credential_records_bundle_id_fkey"
            columns: ["bundle_id"]
            isOneToOne: false
            referencedRelation: "ips_bundles"
            referencedColumns: ["id"]
          },
        ]
      }
      fly_deployments: {
        Row: {
          app_prefix: string
          created_at: string
          faucet_url: string | null
          id: string
          indexer_url: string | null
          indexer_ws_url: string | null
          last_error: string | null
          machines: Json
          node_url: string | null
          proof_url: string | null
          region: string
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          app_prefix: string
          created_at?: string
          faucet_url?: string | null
          id?: string
          indexer_url?: string | null
          indexer_ws_url?: string | null
          last_error?: string | null
          machines?: Json
          node_url?: string | null
          proof_url?: string | null
          region?: string
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          app_prefix?: string
          created_at?: string
          faucet_url?: string | null
          id?: string
          indexer_url?: string | null
          indexer_ws_url?: string | null
          last_error?: string | null
          machines?: Json
          node_url?: string | null
          proof_url?: string | null
          region?: string
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      ips_bundles: {
        Row: {
          bundle: Json
          created_at: string
          digest: string | null
          id: string
          patient_dob: string | null
          patient_name: string | null
          source: string
          title: string
          updated_at: string
          user_id: string
          validation: Json
        }
        Insert: {
          bundle: Json
          created_at?: string
          digest?: string | null
          id?: string
          patient_dob?: string | null
          patient_name?: string | null
          source?: string
          title: string
          updated_at?: string
          user_id: string
          validation?: Json
        }
        Update: {
          bundle?: Json
          created_at?: string
          digest?: string | null
          id?: string
          patient_dob?: string | null
          patient_name?: string | null
          source?: string
          title?: string
          updated_at?: string
          user_id?: string
          validation?: Json
        }
        Relationships: []
      }
      midnight_anchors: {
        Row: {
          block_height: number | null
          bundle_id: string | null
          commitment: string | null
          contract_address: string | null
          created_at: string
          credential_id: string | null
          digest: string
          entry_id: string | null
          entry_point: string | null
          id: string
          last_error: string | null
          network: string
          status: string
          tx_hash: string | null
          updated_at: string
          user_id: string
        }
        Insert: {
          block_height?: number | null
          bundle_id?: string | null
          commitment?: string | null
          contract_address?: string | null
          created_at?: string
          credential_id?: string | null
          digest: string
          entry_id?: string | null
          entry_point?: string | null
          id?: string
          last_error?: string | null
          network?: string
          status?: string
          tx_hash?: string | null
          updated_at?: string
          user_id: string
        }
        Update: {
          block_height?: number | null
          bundle_id?: string | null
          commitment?: string | null
          contract_address?: string | null
          created_at?: string
          credential_id?: string | null
          digest?: string
          entry_id?: string | null
          entry_point?: string | null
          id?: string
          last_error?: string | null
          network?: string
          status?: string
          tx_hash?: string | null
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "midnight_anchors_bundle_id_fkey"
            columns: ["bundle_id"]
            isOneToOne: false
            referencedRelation: "ips_bundles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "midnight_anchors_credential_id_fkey"
            columns: ["credential_id"]
            isOneToOne: false
            referencedRelation: "credential_records"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          created_at: string
          display_name: string | null
          email: string | null
          id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          display_name?: string | null
          email?: string | null
          id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          display_name?: string | null
          email?: string | null
          id?: string
          updated_at?: string
        }
        Relationships: []
      }
      sample_bundles: {
        Row: {
          bundle: Json
          created_at: string
          description: string | null
          id: string
          provenance: string | null
          slug: string
          title: string
        }
        Insert: {
          bundle: Json
          created_at?: string
          description?: string | null
          id?: string
          provenance?: string | null
          slug: string
          title: string
        }
        Update: {
          bundle?: Json
          created_at?: string
          description?: string | null
          id?: string
          provenance?: string | null
          slug?: string
          title?: string
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
    }
    Enums: {
      app_role: "admin" | "moderator" | "user"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["admin", "moderator", "user"],
    },
  },
} as const
