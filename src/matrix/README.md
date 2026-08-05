# Matrix surface

QM can connect to one Matrix homeserver as a normal bot account. It uses the Matrix Client-Server API directly and does not require federation or an application service.

Set all of these environment variables together:

- `MATRIX_HOMESERVER_URL`: the homeserver base URL
- `MATRIX_ACCESS_TOKEN`: a normal Matrix client access token for the bot account
- `MATRIX_ALLOWED_ROOM_IDS`: comma-separated room IDs QM may read and answer in
- `MATRIX_ALLOWED_USER_IDS`: comma-separated Matrix user IDs QM may accept commands from
- `MATRIX_PRINCIPAL_MAP_JSON`: optional JSON mapping from Matrix user IDs to QM principal IDs
- `MATRIX_SYNC_TIMEOUT_MS`: optional long-poll timeout from 1000 through 60000 milliseconds
- `MATRIX_SYNC_CURSOR_PATH`: optional durable sync-cursor path; defaults to `matrix-sync-cursor` under `DATA_DIR`

Configuration is fail-closed. A partial credential or empty allowlist prevents the Matrix surface from being configured. Access tokens are sent only in the Authorization header.

Direct messages are always addressed to QM. Shared rooms require an explicit mention or a reply to QM. Replies remain in Matrix threads and reactions are preserved. Ambient Matrix turns and Matrix approval commands are disabled; use the authenticated QM web interface for approvals.

Every configured room must use invite-only joins, joined-member history visibility, forbidden guest access, no encryption, and only the bot plus allowlisted joined or invited users. QM checks those conditions before accepting an event and again before delivering a result. Encrypted rooms are intentionally ignored because this transport does not include Olm, Megolm, or native crypto bindings.

The sync cursor is checkpointed only after events are handled successfully. Outbound Matrix transaction IDs are deterministic, so a crash between delivery and checkpointing retries without duplicating the message. Run one Matrix-enabled QM consumer per cursor path; multi-replica leader election is not implemented yet.
