mock_provider "aws" {}

run "sandbox_plan" {
  command = plan

  variables {
    aws_region                  = "us-east-2"
    environment                 = "sandbox"
    image_digest               = "111122223333.dkr.ecr.us-east-2.amazonaws.com/applied-ai-residency@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    private_subnet_ids          = ["subnet-private-a", "subnet-private-b"]
    service_security_group_ids = ["sg-trusted-gateway-only"]
    otel_collector_image       = "public.ecr.aws/aws-observability/aws-otel-collector@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    desired_count              = 1
    max_count                  = 2
    monthly_model_budget_usd   = 100
  }

  override_data {
    target = data.aws_subnet.selected["subnet-private-a"]
    values = { availability_zone = "us-east-2a" }
  }

  override_data {
    target = data.aws_subnet.selected["subnet-private-b"]
    values = { availability_zone = "us-east-2b" }
  }

  assert {
    condition     = aws_ecs_service.service.desired_count == 1
    error_message = "The sandbox plan must remain right-sized."
  }

  assert {
    condition     = aws_ecs_service.service.network_configuration[0].assign_public_ip == false
    error_message = "The ECS sandbox must remain private."
  }
}
