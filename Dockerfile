# Sử dụng base image chính thức của Bun (phiên bản slim cho nhẹ)
FROM oven/bun:1-slim as base

# Thiết lập thư mục làm việc
WORKDIR /app

# [Bước 1: Cache dependencies]
# Copy package files trước để tận dụng Docker layer caching
# Nếu code thay đổi nhưng deps không đổi, bước này sẽ được skip (build siêu nhanh)
COPY package.json bun.lockb* ./

# Cài đặt dependencies (chỉ production deps)
RUN bun install --production

# [Bước 2: Copy source code]
COPY index.ts .

# Thiết lập biến môi trường mặc định (có thể override khi run)
ENV PORT=3000
ENV NODE_ENV=production

# Expose port để container giao tiếp
EXPOSE 3000

# Lệnh chạy ứng dụng
CMD ["bun", "index.ts"]
