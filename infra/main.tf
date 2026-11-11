terraform {
  required_version = ">= 1.5.0"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

variable "environment" {
  type    = string
  default = "prod"
}

variable "vpc_subnet_ids" {
  type    = list(string)
  default = []
}

resource "aws_kms_key" "context_data" {
  description             = "Customer-managed encryption for voice transcripts and workspace notes"
  deletion_window_in_days = 30
  enable_key_rotation     = true
}

resource "aws_s3_bucket" "transcript_archive" {
  bucket = "meeting-context-archive-${var.environment}"
}

resource "aws_s3_bucket_server_side_encryption_configuration" "transcript_archive" {
  bucket = aws_s3_bucket.transcript_archive.id
  rule {
    apply_server_side_encryption_by_default {
      kms_master_key_id = aws_kms_key.context_data.arn
      sse_algorithm     = "aws:kms"
    }
  }
}

resource "aws_sqs_queue" "agent_jobs_dlq" {
  name                      = "meeting-agent-jobs-dlq-${var.environment}"
  message_retention_seconds = 1209600
  kms_master_key_id         = aws_kms_key.context_data.arn
}

resource "aws_sqs_queue" "agent_jobs" {
  name                       = "meeting-agent-jobs-${var.environment}"
  visibility_timeout_seconds = 90
  kms_master_key_id          = aws_kms_key.context_data.arn
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.agent_jobs_dlq.arn
    maxReceiveCount     = 3
  })
}

resource "aws_iam_role" "ingestion_lambda" {
  name = "meeting-context-ingestion-${var.environment}"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_lambda_function" "ingestion_worker" {
  function_name = "meeting-context-ingestion-${var.environment}"
  role          = aws_iam_role.ingestion_lambda.arn
  runtime       = "nodejs22.x"
  handler       = "dist/lambdaHandler.handleIngestionEvent"
  filename      = "lambda_bundle.zip"
  timeout       = 30
  memory_size   = 512

  environment {
    variables = {
      ENV_NAME      = var.environment
      ARCHIVE_BUCKET = aws_s3_bucket.transcript_archive.id
      AGENT_SQS_URL = aws_sqs_queue.agent_jobs.url
    }
  }
}
