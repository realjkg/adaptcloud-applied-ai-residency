locals {
  tags = merge({
    Application = var.name
    Environment = var.environment
    ManagedBy   = "terraform"
    DataClass   = "synthetic-only"
  }, var.tags)

  runtime_environment = [
    { name = "APP_ENV", value = var.environment },
    { name = "AUTH_MODE", value = "gateway" },
    { name = "SECRET_SOURCE", value = "managed" },
    { name = "AUDIT_SINK", value = "managed-immutable" },
    { name = "TELEMETRY_EXPORTER", value = "otlp" },
    { name = "OTEL_EXPORTER_OTLP_ENDPOINT", value = "http://127.0.0.1:4318" },
    { name = "OTEL_SERVICE_NAME", value = var.name },
    { name = "MIN_REPLICAS", value = tostring(var.desired_count) },
    { name = "MULTI_ZONE", value = "true" },
    { name = "AUTOSCALING", value = "true" },
    { name = "CARBON_AWARE_REGION", value = tostring(var.carbon_aware_region) },
    { name = "INFRASTRUCTURE_AS_CODE", value = "true" },
    { name = "AUTOMATIC_ROLLBACK", value = "true" },
    { name = "BACKUP_RESTORE_TESTED", value = tostring(var.backup_restore_tested) },
    { name = "MONTHLY_MODEL_BUDGET_USD", value = tostring(var.monthly_model_budget_usd) }
  ]
}

data "aws_subnet" "selected" {
  for_each = toset(var.private_subnet_ids)
  id       = each.value
}

resource "aws_cloudwatch_log_group" "service" {
  name              = "/ecs/${var.name}-${var.environment}"
  retention_in_days = 30
}

resource "aws_ecs_cluster" "service" {
  name = "${var.name}-${var.environment}"

  setting {
    name  = "containerInsights"
    value = "enhanced"
  }
}

data "aws_iam_policy_document" "task_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "execution" {
  name               = "${var.name}-${var.environment}-execution"
  assume_role_policy = data.aws_iam_policy_document.task_assume.json
}

resource "aws_iam_role_policy_attachment" "execution" {
  role       = aws_iam_role.execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

resource "aws_iam_role" "task" {
  name               = "${var.name}-${var.environment}-task"
  assume_role_policy = data.aws_iam_policy_document.task_assume.json
}

data "aws_iam_policy_document" "telemetry" {
  statement {
    actions = [
      "xray:PutTraceSegments",
      "xray:PutTelemetryRecords",
      "logs:CreateLogStream",
      "logs:PutLogEvents"
    ]
    resources = ["*"]
  }
}

resource "aws_iam_role_policy" "telemetry" {
  name   = "metadata-telemetry"
  role   = aws_iam_role.task.id
  policy = data.aws_iam_policy_document.telemetry.json
}

resource "aws_ecs_task_definition" "service" {
  family                   = "${var.name}-${var.environment}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.execution.arn
  task_role_arn            = aws_iam_role.task.arn

  container_definitions = jsonencode([
    {
      name         = "application"
      image        = var.image_digest
      essential    = true
      environment  = local.runtime_environment
      dependsOn    = [{ containerName = "otel-collector", condition = "HEALTHY" }]
      portMappings = [{ containerPort = 3000, protocol = "tcp" }]
      healthCheck = {
        command     = ["CMD-SHELL", "node -e \"fetch('http://127.0.0.1:3000/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))\""]
        interval    = 30
        timeout     = 5
        retries     = 3
        startPeriod = 20
      }
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.service.name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "application"
        }
      }
    },
    {
      name      = "otel-collector"
      image     = var.otel_collector_image
      essential = true
      command   = ["--config=/etc/ecs/ecs-default-config.yaml"]
      healthCheck = {
        command     = ["CMD", "/healthcheck"]
        interval    = 10
        timeout     = 5
        retries     = 3
        startPeriod = 5
      }
      logConfiguration = {
        logDriver = "awslogs"
        options = {
          awslogs-group         = aws_cloudwatch_log_group.service.name
          awslogs-region        = var.aws_region
          awslogs-stream-prefix = "otel"
        }
      }
    }
  ])
}

resource "aws_ecs_service" "service" {
  name                   = "${var.name}-${var.environment}"
  cluster                = aws_ecs_cluster.service.id
  task_definition        = aws_ecs_task_definition.service.arn
  desired_count          = var.desired_count
  launch_type            = "FARGATE"
  enable_execute_command = false

  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  network_configuration {
    assign_public_ip = false
    subnets          = var.private_subnet_ids
    security_groups  = var.service_security_group_ids
  }

  lifecycle {
    precondition {
      condition     = length(toset([for subnet in data.aws_subnet.selected : subnet.availability_zone])) >= 2
      error_message = "Private subnets must span at least two availability zones."
    }
  }
}

resource "aws_appautoscaling_target" "service" {
  max_capacity       = var.max_count
  min_capacity       = var.desired_count
  resource_id        = "service/${aws_ecs_cluster.service.name}/${aws_ecs_service.service.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_policy" "cpu" {
  name               = "${var.name}-${var.environment}-cpu"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.service.resource_id
  scalable_dimension = aws_appautoscaling_target.service.scalable_dimension
  service_namespace  = aws_appautoscaling_target.service.service_namespace

  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
    target_value       = 60
    scale_in_cooldown  = 300
    scale_out_cooldown = 60
  }
}
