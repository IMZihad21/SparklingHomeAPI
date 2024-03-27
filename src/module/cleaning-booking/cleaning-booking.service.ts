import {
  BadRequestException,
  HttpException,
  Injectable,
  Logger,
} from "@nestjs/common";
import { FilterQuery, UpdateQuery } from "mongoose";
import { ApplicationUserDocument } from "../application-user/entities/application-user.entity";
import { ApplicationUserRoleEnum } from "../application-user/enum/application-user-role.enum";
import { PaginatedResponseDto } from "../common/dto/paginated-response.dto";
import { SuccessResponseDto } from "../common/dto/success-response.dto";
import { EmailService } from "../email/email.service";
import { CleaningBookingRepository } from "./cleaning-booking.repository";
import { ListCleaningBookingQueryDto } from "./dto/list-cleaning-booking-query.dto";
import { UpdateCleaningBookingDto } from "./dto/update-cleaning-booking.dto";
import { CleaningBookingDocument } from "./entities/cleaning-booking.entity";
import { CleaningBookingPaymentStatusEnum } from "./enum/cleaning-booking-payment-status.enum";
import { CleaningBookingStatusEnum } from "./enum/cleaning-booking-status.enum";

@Injectable()
export class CleaningBookingService {
  private readonly logger: Logger = new Logger(CleaningBookingService.name);

  constructor(
    private readonly cleaningBookingRepository: CleaningBookingRepository,
    private readonly emailService: EmailService,
  ) {}

  async getAllPaidBooking(
    {
      Page = 1,
      PageSize = 10,
      BookingUserId = "",
    }: ListCleaningBookingQueryDto,
    { userId, userRole }: ITokenPayload,
  ): Promise<PaginatedResponseDto> {
    try {
      // Search query setup
      const searchQuery: FilterQuery<CleaningBookingDocument> = {
        bookingStatus: CleaningBookingStatusEnum.BookingCompleted,
        paymentStatus: CleaningBookingPaymentStatusEnum.PaymentCompleted,
      };

      if (userRole !== ApplicationUserRoleEnum.ADMIN) {
        searchQuery.bookingUser = userId;
      } else if (!!BookingUserId) {
        searchQuery.bookingUser = BookingUserId;
      }

      // Pagination setup
      const totalRecords =
        await this.cleaningBookingRepository.count(searchQuery);
      const skip = (Page - 1) * PageSize;

      const result = await this.cleaningBookingRepository.getAll(searchQuery, {
        limit: PageSize,
        skip,
        populate: [
          {
            path: "bookingUser",
            select: "email fullName profilePicture",
          },
          { path: "paymentReceive", select: "-_id totalPaid paymentIntentId" },
        ],
      });

      return new PaginatedResponseDto(totalRecords, Page, PageSize, result);
    } catch (error) {
      if (error instanceof HttpException) throw error;

      this.logger.error("Error finding users:", error);
      throw new BadRequestException("Could not get all users");
    }
  }

  async updateBooking(
    bookingId: string,
    bookingUpdateDto: UpdateCleaningBookingDto,
    authUserId: string,
  ): Promise<SuccessResponseDto> {
    try {
      if (Object.keys(bookingUpdateDto).length < 1)
        throw new BadRequestException("No fields to update");

      const currentBooking = await this.cleaningBookingRepository.getOneWhere(
        {
          _id: bookingId,
          isActive: true,
          bookingStatus: {
            $nin: [
              CleaningBookingStatusEnum.BookingCancelled,
              CleaningBookingStatusEnum.BookingCompleted,
            ],
          },
          paymentStatus: {
            $ne: CleaningBookingPaymentStatusEnum.PaymentCompleted,
          },
        },
        {
          populate: "bookingUser",
        },
      );

      if (!currentBooking)
        throw new BadRequestException(
          "No active booking found with id: " + bookingId,
        );

      const updateQuery: UpdateQuery<CleaningBookingDocument> = {
        updatedBy: authUserId,
        updatedAt: new Date(),
      };

      if (bookingUpdateDto.cleaningDate) {
        updateQuery.cleaningDate = bookingUpdateDto.cleaningDate;
      }

      if (bookingUpdateDto.remarks) {
        updateQuery.remarks = bookingUpdateDto.remarks;
      }

      if (bookingUpdateDto.additionalCharges) {
        updateQuery.additionalCharges = bookingUpdateDto.additionalCharges;

        updateQuery.totalAmount = Math.ceil(
          currentBooking.cleaningPrice +
            bookingUpdateDto.additionalCharges +
            currentBooking.suppliesCharges -
            currentBooking.discountAmount,
        );
      }

      if (bookingUpdateDto.markAsServed) {
        if (
          currentBooking.bookingStatus !==
          CleaningBookingStatusEnum.BookingInitiated
        )
          throw new BadRequestException(
            "Booking status is not eligible for update",
          );

        updateQuery.bookingStatus = CleaningBookingStatusEnum.BookingServed;
      }

      const updatedBooking = await this.cleaningBookingRepository.updateOneById(
        currentBooking.id,
        updateQuery,
      );

      const bookingUser =
        currentBooking.bookingUser as unknown as ApplicationUserDocument;

      if (bookingUpdateDto?.markAsServed) {
        this.emailService.sendBookingServedMail(bookingUser.email);
      }

      if (bookingUpdateDto?.cleaningDate) {
        this.emailService.sendBookingConfirmedMail(
          bookingUser.email,
          updatedBooking.cleaningDate,
        );
      }

      return new SuccessResponseDto(
        "Booking updated successfully",
        updatedBooking,
      );
    } catch (error) {
      if (error instanceof HttpException) throw error;

      this.logger.error("Error updating booking:", error);
      throw new BadRequestException("Could not update booking");
    }
  }

  async getTopBookingUsers(): Promise<SuccessResponseDto> {
    try {
      const result =
        await this.cleaningBookingRepository.findTopUsersByBooking();

      return new SuccessResponseDto("All top users fetched", result);
    } catch (error) {
      if (error instanceof HttpException) throw error;

      this.logger.error("Error fetching booking users:", error);
      throw new BadRequestException("Could not get booking users");
    }
  }
}
