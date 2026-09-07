output "cluster_arn" {
  value = aws_ecs_cluster.service.arn
}

output "service_name" {
  value = aws_ecs_service.service.name
}

output "task_role_arn" {
  value = aws_iam_role.task.arn
}

output "operator_next_step" {
  value = "Attach this private ECS service to the platform-owned authenticating gateway; do not expose its security group publicly."
}
