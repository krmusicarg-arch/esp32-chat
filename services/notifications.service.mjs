export async function claimPendingNotifications(supabase, { memberId, limit = 5 }) {
  return supabase.rpc("claim_due_notifications", {
    p_member_id: memberId,
    p_limit: limit,
  });
}

export async function acknowledgeNotification(supabase, {
  deliveryId,
  memberId,
  success,
  error,
}) {
  const result = await supabase.rpc("ack_notification_delivery", {
    p_delivery_id: deliveryId,
    p_member_id: memberId,
    p_success: success,
    p_error: error || null,
  });
  return result === true || result?.[0] === true;
}
